/* @flow */

import * as assert from "assert";
import * as _ from "lodash";
import * as path from "path";
import * as ssh2 from "ssh2";
import { TransferOptions } from "ssh2-streams";
import * as stream from "stream";
import * as helpers from "./helpers";
import {
    IClientChannelShell,
    ICommand,
    IExecCommandOptions,
    IExecCommandResult,
    IExecOptions,
    ILocalRemotePair,
    IPutDirectoryOptions
} from "./types";

import scanDirectory from "sb-scandir";
import shellEscape = require("shell-escape");

export class SSH {
    public connection?: ssh2.Client;

    // hooks for reading stdout during exec statements
    public stdout: NodeJS.ReadWriteStream;
    public stderr: NodeJS.ReadWriteStream;

    private references = 0;
    private sudoPassword: string;
    private sudoModeEnabled: boolean = false;

    constructor(private config?: ssh2.ConnectConfig) {
        this.connection = null;
    }

    public enableSudoMode(sudoPassword: string) {
        this.sudoPassword = sudoPassword;
        this.sudoModeEnabled = true;
    }

    public diableSudoMode() {
        this.sudoPassword = null;
        this.sudoModeEnabled = false;
    }

    public async connect(givenConfig?: ssh2.ConnectConfig) {
        let retval = Promise.resolve(this);

        this.references++;

        if (!this.connection) {
            const connection = new ssh2.Client();
            this.connection = connection;
            this.stdout = new stream.PassThrough();
            this.stderr = new stream.PassThrough();

            if (!givenConfig) {
                givenConfig = this.config;
            }

            const config = await helpers.normalizeConfig(givenConfig);

            retval = new Promise<this>((resolve, reject) => {
                connection.on("error", reject);

                connection.on("ready", () => {
                    connection.removeListener("error", reject);
                    resolve(this);
                });

                connection.on("end", () => {
                    if (this.connection === connection) {
                        this.connection = null;
                    }
                });

                connection.connect(config);
            });
        }

        return retval;
    }

    public async requestSFTP() {
        const connection = this.connection;
        assert(connection, "Not connected to server");

        return new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
            connection.sftp(helpers.generateCallback(resolve, reject));
        });
    }

    public async mkdir(mkdirPath: string,
                       type: "exec" | "sftp" = "sftp",
                       givenSftp: ssh2.SFTPWrapper = null): Promise<void> {

        assert(this.connection, "Not connected to server");
        assert(type === "exec" || type === "sftp", "Type should either be sftp or exec");
        if (type === "exec") {
            const output = await this.exec("mkdir", ["-p", mkdirPath]);
        } else {
            assert(!givenSftp || _.isObject(givenSftp), "sftp must be an object");
            const sftp = givenSftp || await this.requestSFTP();

            const makeSftpDirectory = (retry) =>
                helpers.mkdirSftp(mkdirPath, sftp).catch((error) => {
                    if (retry && error && (error.message === "No such file" || error.code === "ENOENT")) {
                        return this.mkdir(path.dirname(mkdirPath), "sftp", sftp).then(() => makeSftpDirectory(false));
                    }
                    throw error;
                });
            try {
                await makeSftpDirectory(true);
            } finally {
                if (!givenSftp) {
                    sftp.end();
                }
            }
        }
    }

    public async exec(command: string): Promise<string>;
    public async exec(command: string, parameters: string[]): Promise<string>;
    public async exec(command: string, parameters: string[] = [], options: IExecOptions = {}) {
        assert(this.connection, "Not connected to server");
        assert(_.isObject(options) && options, "options must be an Object");
        assert(!options.cwd || _.isString(options.cwd), "options.cwd must be a string");
        assert(!options.stdin || _.isString(options.stdin), "options.stdin must be a string");
        assert(!options.stream || ["stdout", "stderr", "both"].indexOf(options.stream) !== -1,
            'options.stream must be among "stdout", "stderr" and "both"');
        assert(!options.options || _.isObject(options.options), "options.options must be an object");

        const output = await this.execCommand([command].concat(shellEscape(parameters)).join(" "), options);
        if (!options.stream || options.stream === "stdout") {
            if (output.stderr) {
                throw new Error(output.stderr);
            }
            return output.stdout;
        }
        if (options.stream === "stderr") {
            return output.stderr;
        }
        return output;
    }

    public async execCommand(givenCommand: string, options: IExecCommandOptions = {}) {
        let command = givenCommand;
        const connection = this.connection;
        assert(connection, "Not connected to server");
        assert(_.isObject(options) && options, "options must be an Object");
        assert(!options.cwd || _.isString(options.cwd), "options.cwd must be a string");
        assert(!options.stdin || _.isString(options.stdin), "options.stdin must be a string");
        assert(!options.options || _.isObject(options.options), "options.options must be an object");
        assert(_.isUndefined(options.useSudo) || _.isBoolean(options.useSudo), "options.useSudo must be a boolean");

        if (options.cwd) {
            // NOTE: Output piping cd command to hide directory non-existent errors
            command = `cd ${shellEscape([options.cwd])} 1> /dev/null 2> /dev/null; ${command}`;
        }
        const output = { stdout: [], stderr: [] };
        const shouldCheckPassword = options && options.useSudo && this.sudoModeEnabled;

        return new Promise<IExecCommandResult>((resolve, reject) => {
            const handleCallback = (originalChannel: ssh2.ClientChannel) => {
                const channel = this.wrapChannel(originalChannel);

                if (shouldCheckPassword) {
                    channel.once("password", (callback) => {
                        channel.write(`${this.sudoPassword}\n`);
                    });
                }

                channel.stdout.on("data", (chunk) => {
                    output.stdout.push(chunk);
                });

                channel.stderr.on("data", (chunk) => {
                    output.stderr.push(chunk);
                });

                if (options.stdin) {
                    channel.write(options.stdin);
                    channel.end();
                }

                channel.on("close", (code, signal) => {
                    resolve({
                        code,
                        signal,
                        stderr: output.stderr.join("").trim(),
                        stdout: output.stdout.join("").trim()
                    });
                });
            };

            connection.exec(command, options.options || {}, helpers.generateCallback(handleCallback, reject));
        });
    }

    public async getFile(localFile: string,
                         remoteFile: string,
                         givenSftp: ssh2.SFTPWrapper = null,
                         givenOpts: TransferOptions = null): Promise<void> {

        assert(this.connection, "Not connected to server");
        assert(_.isString(localFile) && localFile, "localFile must be a string");
        assert(_.isString(remoteFile) && remoteFile, "remoteFile must be a string");
        assert(!givenSftp || _.isObject(givenSftp), "sftp must be an object");
        assert(!givenOpts || _.isObject(givenOpts), "opts must be an object");

        const opts = givenOpts || {};
        const sftp = givenSftp || await this.requestSFTP();

        try {
            await new Promise((resolve, reject) => {
                sftp.fastGet(remoteFile, localFile, opts, helpers.generateCallback(resolve, reject));
            });
        } finally {
            if (!givenSftp) {
                sftp.end();
            }
        }
    }

    public async putFile(localFile: string,
                         remoteFile: string,
                         givenSftp: ssh2.SFTPWrapper = null,
                         givenOpts: TransferOptions = null): Promise<void> {

        assert(this.connection, "Not connected to server");
        assert(_.isString(localFile) && localFile, "localFile must be a string");
        assert(_.isString(remoteFile) && remoteFile, "remoteFile must be a string");
        assert(!givenSftp || _.isObject(givenSftp), "sftp must be an object");
        assert(!givenOpts || _.isObject(givenOpts), "opts must be an object");
        assert(await helpers.exists(localFile), `localFile does not exist at ${localFile}`);

        const that = this;
        const opts = givenOpts || {};
        const sftp = givenSftp || await this.requestSFTP();

        function putFile(retry: boolean) {
            return new Promise((resolve, reject) => {
                sftp.fastPut(localFile, remoteFile, opts, helpers.generateCallback(resolve, (error: Error) => {
                    if (error.message === "No such file" && retry) {
                        resolve(that.mkdir(path.dirname(remoteFile), "sftp", sftp).then(() => putFile(false)));
                    } else {
                        reject(error);
                    }
                }));
            });
        }

        try {
            await putFile(true);
        } finally {
            if (!givenSftp) {
                sftp.end();
            }
        }
    }

    public async putFiles(files: Array<{ local: string, remote: string }>,
                          givenSftp: ssh2.SFTPWrapper = null,
                          maxAtOnce: number = 5,
                          givenOpts: TransferOptions = null): Promise<void> {

        assert(this.connection, "Not connected to server");
        assert(!givenSftp || _.isObject(givenSftp), "sftp must be an object");
        assert(!givenOpts || _.isObject(givenOpts), "opts must be an object");
        assert(Array.isArray(files), "files must be an array");
        assert(typeof maxAtOnce === "number" && Number.isFinite(maxAtOnce), "maxAtOnce must be a valid number");

        for (let i = 0, length = files.length; i < length; ++i) {
            const file = files[i];
            assert(file, "files items must be valid objects");
            assert(file.local && _.isString(file.local), `files[${i}].local must be a string`);
            assert(file.remote && _.isString(file.remote), `files[${i}].remote must be a string`);
        }

        const opts = givenOpts || {};
        const sftp = givenSftp || await this.requestSFTP();
        let transferred = [];

        try {
            for (let i = 0, length = Math.ceil(files.length / maxAtOnce); i < length; i++) {
                const index = i * maxAtOnce;
                const chunk = files.slice(index, index + maxAtOnce);
                await Promise.all(chunk.map((file) => this.putFile(file.local, file.remote, sftp, opts)));
                transferred = transferred.concat(chunk);
            }
        } catch (error) {
            error.transferred = transferred;
            throw error;
        } finally {
            if (!sftp) {
                sftp.end();
            }
        }
    }

    public async putDirectory(localDirectory: string,
                              remoteDirectory: string,
                              givenConfig: Partial<IPutDirectoryOptions> = {},
                              givenSftp: ssh2.SFTPWrapper = null,
                              givenOpts: TransferOptions = null): Promise<boolean> {

        assert(this.connection, "Not connected to server");
        assert(_.isString(localDirectory) && localDirectory, "localDirectory must be a string");
        assert(_.isString(remoteDirectory) && remoteDirectory, "localDirectory must be a string");
        assert(await helpers.exists(localDirectory), `localDirectory does not exist at ${localDirectory}`);
        assert((await helpers.stat(localDirectory)).isDirectory(),
            `localDirectory is not a directory at ${localDirectory}`);
        assert(_.isObject(givenConfig) && givenConfig, "config must be an object");
        assert(!givenSftp || _.isObject(givenSftp), "sftp must be an object");
        assert(!givenOpts || _.isObject(givenOpts), "opts must be an object");

        const opts = givenOpts || {};
        const sftp = givenSftp || await this.requestSFTP();
        const config = helpers.normalizePutDirectoryConfig(givenConfig);
        const files = (await scanDirectory(localDirectory, config.recursive, config.validate))
            .map((i) => path.relative(localDirectory, i));
        const directoriesCreated = new Set();
        let directoriesQueue = Promise.resolve();

        // eslint-disable-next-line arrow-parens
        const promises = files.map(async (file) => {
            const localFile = path.join(localDirectory, file);
            const remoteFile = path.join(remoteDirectory, file).split(path.sep).join("/");
            const remoteFileDirectory = path.dirname(remoteFile);
            if (!directoriesCreated.has(remoteFileDirectory)) {
                directoriesCreated.add(remoteFileDirectory);
                directoriesQueue = directoriesQueue.then(() => this.mkdir(remoteFileDirectory, "sftp", sftp));
                await directoriesQueue;
            }
            try {
                await this.putFile(localFile, remoteFile, sftp, opts);
                config.tick(localFile, remoteFile, null);
                return true;
            } catch (_) {
                config.tick(localFile, remoteFile, _);
                return false;
            }
        });

        let results;
        try {
            results = await Promise.all(promises);
        } finally {
            if (!givenSftp) {
                sftp.end();
            }
        }

        return results.every((i) => i);
    }

    public dispose() {
        if (this.references > 0) {
            this.references--;
        }

        if (this.references === 0 && this.connection) {
            this.connection.end();
            this.connection = null;
            this.stdout.end();
            this.stderr.end();
        }
    }

    public execSudoCommand(command: string) {
        if (this.sudoModeEnabled) {
            const encodedCommand = new Buffer(command).toString("base64");

            return this.execCommand(`echo '${encodedCommand}' | base64 -d | sudo -i -u jworg_qa bash`, {
                options: {
                    pty: true
                },
                useSudo: true
            });
        } else {
            return this.execCommand(command);
        }
    }

    public shell(): Promise<IClientChannelShell> {
        const options: ssh2.ExecOptions = {
            pty: true
        };

        return new Promise((resolve, reject) => {
            this.connection.exec(` stty -echo; bash`, options, (err, originalChannel) => {
                if (err) {
                    reject(err);
                    return;
                }

                const channel = this.wrapChannel(originalChannel);

                resolve(channel);
            });
        });
    }

    public sudoShell(): Promise<IClientChannelShell> {
        if (this.sudoModeEnabled) {
            const options: ssh2.ExecOptions = {
                pty: true
            };

            return new Promise((resolve, reject) => {
                this.connection.exec(` stty -echo; sudo -i -u jworg_qa`, options, (err, originalChannel) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const channel = this.wrapChannel(originalChannel);

                    channel.once("password", (callback) => {
                        channel.write(`${this.sudoPassword}\n`);
                    });

                    resolve(channel);
                });
            });
        } else {
            return this.shell();
        }
    }

    public async runCommandsInShell(commands: Array<string | ICommand>, sudo = false) {
        let output: { stdout: string[], stderr: string[] };
        let channel: IClientChannelShell;
        let recording = false;

        output = { stdout: [], stderr: [] };
        channel = sudo ?
            await this.sudoShell() :
            await this.shell();

        return new Promise<string>((resolve, reject) => {
            channel.on("prompt", () => {
                let cmd: (ICommand | string) = commands.shift();
                recording = false;

                if (_.isString(cmd)) {
                    cmd = { cmd, output: false };
                }

                if (cmd) {
                    if (cmd.output) {
                        recording = true;
                    }

                    // tslint:disable-next-line:no-console
                    console.log("Command: " + cmd.cmd);
                    channel.write(`${cmd.cmd}\n`);
                } else {
                    channel.close();
                }
            });

            channel.stdout.on("data", saveToStdOut);
            channel.stderr.on("data", saveToStdError);

            channel.on("close", (code, signal) => {
                if (output.stderr.length) {
                    reject(output.stderr.join("").trim());
                } else {
                    resolve(output.stdout.join("").trim());
                }
            });

            channel.resume();
        });

        function saveToStdOut(chunk) {
            if (recording) {
                output.stdout.push(chunk);
            }
        }

        function saveToStdError(chunk) {
            if (recording) {
                output.stderr.push(chunk);
            }
        }
    }

    private wrapChannel(originalChannel: ssh2.ClientChannel) {
        const channel: IClientChannelShell = originalChannel as IClientChannelShell;

        const transform = new stream.Transform({
            transform(chunk: Buffer, encoding: string, callback: () => void) {
                try {
                    const lines = chunk.toString().split(/(\r\n)/g);

                    _.each(lines, (chunkString) => {
                        if (/^\[sudo\] password for.*$/.test(chunkString)) {
                            channel.emit("password");
                            channel.ignoreChunk = "\r\n";
                        } else if (/\$ $/.test(chunkString)) {
                            channel.emit("prompt");
                        } else if (channel.ignoreChunk === chunkString) {
                            channel.ignoreChunk = null;
                        } else {
                            transform.push(chunkString);
                        }
                    });
                } finally {
                    callback();
                }
            }
        });

        channel.once("error", (err: any) => {
            transform.emit("error", err);
        });

        channel.pause();

        channel.stdout = channel.pipe(transform) as any;

        channel.stdout.pipe(this.stdout, { end: false });
        channel.stderr.pipe(this.stderr, { end: false });

        channel.once("finish", () => {
            channel.stdout.unpipe(this.stdout);
            channel.stderr.unpipe(this.stderr);
        });

        return channel;
    }
}
