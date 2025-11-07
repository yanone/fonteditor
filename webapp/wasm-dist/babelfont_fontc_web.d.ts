/* tslint:disable */
/* eslint-disable */
/**
 * Compile a font from babelfont JSON directly to TTF
 * 
 * This is the main entry point that takes a .babelfont JSON string
 * and produces compiled TTF bytes.
 * 
 * # Arguments
 * * `babelfont_json` - JSON string in .babelfont format
 * 
 * # Returns
 * * `Vec<u8>` - Compiled TTF font bytes
 */
export function compile_babelfont(babelfont_json: string): Uint8Array;
/**
 * Legacy function for compatibility
 */
export function compile_glyphs(_glyphs_json: string): Uint8Array;
/**
 * Get version information
 */
export function version(): string;
export function init(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly compile_babelfont: (a: number, b: number) => [number, number, number, number];
  readonly compile_glyphs: (a: number, b: number) => [number, number, number, number];
  readonly init: () => void;
  readonly version: () => [number, number];
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
