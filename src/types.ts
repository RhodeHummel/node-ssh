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
    password?: string;
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
