/** Declaration file generated by dts-gen */

export = sb_scandir;

declare function sb_scandir(directory: string,
                            recursive?: boolean,
                            filter?: (path: string) => boolean): Promise<string[]>;
