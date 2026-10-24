/**
 * Import this module first. The app protocol runs on a Unix socket, so stdout carries no
 * frames; main treats stdout and stderr as logs. Routing console output to stderr keeps the
 * two log streams ordered, and means no code (ours or omp's) can ever write to the protocol.
 */
const toStderr = (...args: unknown[]): void => console.error(...args);

console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
