/* @flow */

import * as assert from "assert";
import * as _ from "lodash";
import * as path from "path";
import * as ssh2 from "ssh2";
import { TransferOptions } from "ssh2-streams";
import * as helpers from "./helpers";
import { IExecCommandOptions, IExecCommandResult, IExecOptions, ILocalRemotePair, IPutDirectoryOptions } from "./types";

import scanDirectory from "sb-scandir";
import shellEscape = require("shell-escape");

export {
    TransferOptions,
    IExecCommandOptions,
    IExecCommandResult,
    IExecOptions,
    ILocalRemotePair,
    IPutDirectoryOptions
};

export class SSH {

    public connection?: ssh2.Client;

    constructor() {
        this.connection = null;
    }

    public async connect(givenConfig: ssh2.ConnectConfig) {
        const connection = new ssh2.Client();
        this.connection = connection;

        const config = await helpers.normalizeConfig(givenConfig);

        return new Promise<this>((resolve, reject) => {
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

    public async requestShell() {
        const connection = this.connection;
        assert(connection, "Not connected to server");
        return new Promise<ssh2.ClientChannel>((resolve, reject) => {
            connection.shell(helpers.generateCallback(resolve, reject));
        });
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

            if (!_.isString(output) && output.stdout) {
                throw new Error(output.stdout);
            }

        } else {
            assert(!givenSftp || typeof givenSftp === "object", "sftp must be an object");
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

    public async exec(command: string, parameters: string[] = [], options: IExecOptions = {}) {
        assert(this.connection, "Not connected to server");
        assert(typeof options === "object" && options, "options must be an Object");
        assert(!options.cwd || typeof options.cwd === "string", "options.cwd must be a string");
        assert(!options.stdin || typeof options.stdin === "string", "options.stdin must be a string");
        assert(!options.stream || ["stdout", "stderr", "both"].indexOf(options.stream) !== -1,
            'options.stream must be among "stdout", "stderr" and "both"');
        assert(!options.options || typeof options.options === "object", "options.options must be an object");

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
        assert(typeof options === "object" && options, "options must be an Object");
        assert(!options.cwd || typeof options.cwd === "string", "options.cwd must be a string");
        assert(!options.stdin || typeof options.stdin === "string", "options.stdin must be a string");
        assert(!options.options || typeof options.options === "object", "options.options must be an object");
        assert(!options.password || typeof options.password === "string", "options.password must be a string");

        if (options.cwd) {
            // NOTE: Output piping cd command to hide directory non-existent errors
            command = `cd ${shellEscape([options.cwd])} 1> /dev/null 2> /dev/null; ${command}`;
        }
        const output = { stdout: [], stderr: [] };
        const shouldCheckPassword = options && options.password && options.options && options.options.pty;

        return new Promise<IExecCommandResult>((resolve, reject) => {
            const handleCallback = (stream: ssh2.ClientChannel) => {
                stream.on("data", (chunk) => {
                    if (shouldCheckPassword && /^\[sudo\] password for.*$/.test(chunk)) {
                        // send password to tty
                        stream.write(`${options.password}\n`);
                    } else {
                        output.stdout.push(chunk);
                    }
                });
                stream.stderr.on("data", (chunk) => {
                    output.stderr.push(chunk);
                });
                if (options.stdin) {
                    stream.write(options.stdin);
                    stream.end();
                }
                stream.on("close", (code, signal) => {
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
        assert(typeof localFile === "string" && localFile, "localFile must be a string");
        assert(typeof remoteFile === "string" && remoteFile, "remoteFile must be a string");
        assert(!givenSftp || typeof givenSftp === "object", "sftp must be an object");
        assert(!givenOpts || typeof givenOpts === "object", "opts must be an object");

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
        assert(typeof localFile === "string" && localFile, "localFile must be a string");
        assert(typeof remoteFile === "string" && remoteFile, "remoteFile must be a string");
        assert(!givenSftp || typeof givenSftp === "object", "sftp must be an object");
        assert(!givenOpts || typeof givenOpts === "object", "opts must be an object");
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
        assert(!givenSftp || typeof givenSftp === "object", "sftp must be an object");
        assert(!givenOpts || typeof givenOpts === "object", "opts must be an object");
        assert(Array.isArray(files), "files must be an array");
        assert(typeof maxAtOnce === "number" && Number.isFinite(maxAtOnce), "maxAtOnce must be a valid number");

        for (let i = 0, length = files.length; i < length; ++i) {
            const file = files[i];
            assert(file, "files items must be valid objects");
            assert(file.local && typeof file.local === "string", `files[${i}].local must be a string`);
            assert(file.remote && typeof file.remote === "string", `files[${i}].remote must be a string`);
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
        assert(typeof localDirectory === "string" && localDirectory, "localDirectory must be a string");
        assert(typeof remoteDirectory === "string" && remoteDirectory, "localDirectory must be a string");
        assert(await helpers.exists(localDirectory), `localDirectory does not exist at ${localDirectory}`);
        assert((await helpers.stat(localDirectory)).isDirectory(),
            `localDirectory is not a directory at ${localDirectory}`);
        assert(typeof givenConfig === "object" && givenConfig, "config must be an object");
        assert(!givenSftp || typeof givenSftp === "object", "sftp must be an object");
        assert(!givenOpts || typeof givenOpts === "object", "opts must be an object");

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
        if (this.connection) {
            this.connection.end();
        }
    }
}
