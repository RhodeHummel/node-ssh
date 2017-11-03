/* @flow */

import * as fs from "fs";
import * as _ from "lodash";
import * as path from "path";
import { promisify } from "sb-promisify";
import * as ssh2 from "ssh2";
import { IPutDirectoryOptions } from "./types";

const CODE_REGEXP = /Error: (E[\S]+): /;
const readFile = promisify(fs.readFile) as (filename: string, encoding: string) => Promise<string>;
export const stat = promisify(fs.stat) as (path: string | Buffer) => Promise<fs.Stats>;
export const readdir = promisify(fs.readdir) as (path: string | Buffer) => Promise<fs.Stats>;

function transformError(givenError: any) {
    const code = CODE_REGEXP.exec(givenError);

    if (code) {
        // eslint-disable-next-line no-param-reassign
        givenError.code = code[1];
    }

    return givenError;
}

export function exists(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
        fs.access(filePath, fs.constants.R_OK, (error: Error) => {
            resolve(!error);
        });
    });
}

export async function mkdirSftp(path: string, sftp: any): Promise<void> {
    let stats;

    try {
        stats = await promisify(sftp.stat).call(sftp, path);
    } catch (_) { /* No Op */ }

    if (stats) {
        if (stats.isDirectory()) {
            // Already exists, nothing to worry about
            return;
        }

        throw new Error("mkdir() failed, target already exists and is not a directory");
    }

    try {
        await promisify(sftp.mkdir).call(sftp, path);
    } catch (error) {
        throw transformError(error);
    }
}

export async function normalizeConfig(givenConfig: ssh2.ConnectConfig) {
    const config = _.cloneDeep(givenConfig);

    if (config.username && typeof config.username !== "string") {
        throw new Error("config.username must be a valid string");
    }

    if (typeof config.host !== "undefined") {
        if (typeof config.host !== "string" || !config.host) {
            throw new Error("config.host must be a valid string");
        }
    } else if (typeof config.sock !== "undefined") {
        if (!config.sock || typeof config.sock !== "object") {
            throw new Error("config.sock must be a valid object");
        }
    } else {
        throw new Error("config.host or config.sock must be provided");
    }

    if (config.privateKey) {
        const privateKey = config.privateKey;

        if (typeof privateKey !== "string") {
            throw new Error("config.privateKey must be a string");
        }

        if (!(privateKey.includes("BEGIN") && privateKey.includes("KEY"))) {
            try {
                config.privateKey = await readFile(privateKey, "utf8");
            } catch (error) {
                if (error.code === "ENOENT") {
                    throw new Error(`config.privateKey does not exist at ${privateKey}`);
                }
                throw error;
            }
        }
    } else if (config.password) {
        const password = config.password;
        if (typeof password !== "string") {
            throw new Error("config.password must be a string");
        }
    }

    return config;
}

export function normalizePutDirectoryConfig(givenConfig: Partial<IPutDirectoryOptions>): IPutDirectoryOptions {
    const config = _.cloneDeep(givenConfig) as IPutDirectoryOptions;

    if (config.tick) {
        if (typeof config.tick !== "function") {
            throw new Error("config.tick must be a function");
        }
    } else {
        config.tick = _.noop;
    }

    if (config.validate) {
        if (typeof config.validate !== "function") {
            throw new Error("config.validate must be a function");
        }
    } else {
        config.validate = (localPath: string) => {
            return path.basename(localPath).substr(0, 1) !== ".";
        };
    }

    config.recursive = {}.hasOwnProperty.call(config, "recursive") ? !!config.recursive : true;

    return config;
}

export type ResolveFunction<T> = (value?: T | PromiseLike<T>) => void;
export type RejectFunction = (reason?: any) => void;
export type CallbackFunction<T> = (error: any, result?: T) => void;

export function generateCallback<T>(resolve: ResolveFunction<T>, reject: RejectFunction): CallbackFunction<T> {
    return (error, value?: T | PromiseLike<T>) => {
        if (error) {
            reject(error);
        } else {
            resolve(value);
        }
    };
}
