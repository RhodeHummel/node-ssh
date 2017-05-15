/* @flow */

import * as ssh2 from "ssh2";

export interface IPutDirectoryOptions {
  recursive: boolean;
  tick: ((localPath: string, remotePath: string, error?: Error) => void);
  validate: ((localPath: string) => boolean);
}

export interface IExecOptions {
    cwd?: string;
    stdin?: string;
    stream?: "stdout" | "stderr" | "both";
    options?: ssh2.ExecOptions;
}

export interface IExecCommandOptions {
    cwd?: string;
    stdin?: string;
    useSudo?: boolean;
    options?: ssh2.ExecOptions;
}

export interface IExecCommandResult {
    stdout: string;
    stderr: string;
    signal?: string;
    code: number;
}

export interface ILocalRemotePair {
    local: string;
    remote: string;
}

export interface IClientChannelShell extends ssh2.ClientChannel {
    ignoreChunk?: string;

    once(event: "prompt", listener: () => void): this;
    once(event: "password", listener: (callback: (password: string) => void) => void): this;
    // tslint:disable-next-line:ban-types
    once(event: string | symbol, listener: Function): this;

    on(event: "prompt", listener: () => void): this;
    on(event: "password", listener: (callback: (password: string) => void) => void): this;
    // tslint:disable-next-line:ban-types
    on(event: string | symbol, listener: Function): this;

    emit(event: "prompt"): boolean;
    emit(event: "password"): this;
    emit(event: string | symbol, ...args: any[]): boolean;
}