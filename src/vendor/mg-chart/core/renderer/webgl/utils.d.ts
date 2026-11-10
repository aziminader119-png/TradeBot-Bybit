/** Compile a GLSL shader. Throws on error. */
export declare function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader;
/** Link vertex + fragment shaders into a program. Throws on error. */
export declare function linkProgram(gl: WebGL2RenderingContext, vert: WebGLShader, frag: WebGLShader): WebGLProgram;
/** Create a shader program from source strings */
export declare function createProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram;
export declare function parseColor(color: string): readonly [number, number, number, number];
/** Grow a Float32Array by 2x, copying existing data */
export declare function growFloat32(arr: Float32Array, minCapacity: number): Float32Array;
