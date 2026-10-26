/**
 * What a Computer method threw, as it arrives over Workers RPC. Cloudflare keeps a thrown error's `name`,
 * `message`, `code` and other own fields across the call, so a filesystem error still says which code, path
 * and system call failed.
 */
import type { RpcCallError } from 'alchemy';
import { Option, Schema } from 'effect';

const ThrownComputerError = Schema.Struct({
    message: Schema.String,
    /** POSIX-style, such as `ENOENT`. */
    code: Schema.optionalKey(Schema.String),
    path: Schema.optionalKey(Schema.String),
    syscall: Schema.optionalKey(Schema.String),
});

export type ThrownComputerError = typeof ThrownComputerError.Type;

/** The error the Computer threw, or `None` when the call failed before reaching it. */
export const thrownComputerError = (error: RpcCallError): Option.Option<ThrownComputerError> =>
    Schema.decodeUnknownOption(ThrownComputerError)(error.cause);

/** The thrown error's own message, such as `ENOENT: no such file or directory, open '/workspace/x'`. */
export const rpcFailureMessage = (error: RpcCallError): string =>
    Option.match(thrownComputerError(error), { onNone: () => error.message, onSome: ({ message }) => message });
