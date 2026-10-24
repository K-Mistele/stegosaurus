import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Crypto, Effect, Layer, Option, Path, Schedule, Schema, Stream, String as Str } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

class BackendTestFailure extends Schema.TaggedError<BackendTestFailure, { readonly brand: unique symbol }>()(
    'BackendTestFailure',
    { operation: Schema.String },
) {}

const command = Effect.fn('backend_test.command')(function* (input: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env?: Record<string, string>;
}) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* Effect.scoped(
        Effect.gen(function* () {
            const process = yield* spawner.spawn(
                ChildProcess.make(input.executable, input.args, {
                    cwd: input.cwd,
                    env: input.env,
                    extendEnv: true,
                    stdin: 'ignore',
                    stdout: 'pipe',
                    stderr: 'pipe',
                    forceKillAfter: '1 second',
                }),
            );

            const [output, code] = yield* Effect.all(
                [
                    process.all.pipe(
                        Stream.decodeText(),
                        Stream.runFold(
                            () => '',
                            (text, chunk) => Str.slice(-10_000)(text + chunk),
                        ),
                    ),
                    process.exitCode,
                ],
                { concurrency: 2 },
            );

            if (code !== 0) {
                yield* Effect.logError('Backend test command failed', output);

                return yield* BackendTestFailure.make({ operation: input.executable });
            }

            return output;
        }),
    ).pipe(Effect.timeout('45 seconds'));
});

const program = Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../', import.meta.url));
    const crypto = yield* Crypto.Crypto;
    const override = yield* Config.option(Config.String('DOCKER_HOST'));

    const endpoint = yield* command({
        executable: 'docker',
        args: ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        cwd: root,
    });

    const isUnixSocket = Str.startsWith('unix://');

    if (!isUnixSocket(Str.trim(endpoint)) || (Option.isSome(override) && !isUnixSocket(override.value))) {
        return yield* BackendTestFailure.make({
            operation: 'A local Unix-socket Docker daemon is required; remote contexts are refused',
        });
    }

    const postgresPort = 55432;
    const redisPort = 56379;

    const suites = [
        {
            backend: 'postgres',
            config: 'packages/channels-sql/test-backends/vite.postgres.config.ts',
            container: [
                '-p',
                `127.0.0.1:${postgresPort}:5432`,
                '-e',
                'POSTGRES_USER=delivery_test',
                '-e',
                'POSTGRES_PASSWORD=delivery_test',
                '-e',
                'POSTGRES_DB=delivery_adapter_test',
                'postgres:17-alpine',
            ],
            ready: ['pg_isready', '-h', '127.0.0.1', '-U', 'delivery_test', '-d', 'delivery_adapter_test'],
            env: {
                SQL_BACKEND_TEST_DATABASE_URL: `postgres://delivery_test:delivery_test@127.0.0.1:${postgresPort}/delivery_adapter_test`,
            },
        },
        {
            backend: 'redis',
            config: 'packages/channels-redis/test-backends/vite.redis.config.ts',
            container: [
                '-p',
                `127.0.0.1:${redisPort}:6379`,
                'redis:7-alpine',
                'redis-server',
                '--appendonly',
                'yes',
                '--appendfsync',
                'always',
                '--maxmemory-policy',
                'noeviction',
            ],
            ready: ['redis-cli', 'ping'],
            env: { REDIS_CONTRACT_TEST_PORT: String(redisPort) },
        },
    ] as const;

    for (const { backend, ...suite } of suites) {
        yield* Effect.scoped(
            Effect.gen(function* () {
                const name = `channels-test-${yield* crypto.randomUUIDv4()}`;

                const docker = (args: ReadonlyArray<string>) => command({ executable: 'docker', args, cwd: root });

                yield* Effect.acquireRelease(docker(['create', '--name', name, ...suite.container]), () =>
                    docker(['rm', '-fv', name]).pipe(
                        Effect.tapError(() =>
                            Effect.logError('Could not remove owned backend test container', { name }),
                        ),
                        Effect.orDie,
                    ),
                );
                yield* docker(['start', name]);
                yield* docker(['exec', name, ...suite.ready]).pipe(
                    Effect.retry({ times: 20, schedule: Schedule.spaced('250 millis') }),
                );
                yield* Effect.logInfo(`Testing ${suite.config} with a fresh ${backend} container`);

                const result = yield* command({
                    executable: path.join(root, 'node_modules/.bin/vp'),
                    args: ['test', '--config', suite.config],
                    cwd: root,
                    env: {
                        DELIVERY_BACKEND_TEST_CONFIRM: 'disposable',
                        ...suite.env,
                    },
                });

                yield* Effect.logInfo(result);
            }),
        );
    }
});

NodeRuntime.runMain(
    Layer.build(NodeServices.layer).pipe(
        Effect.flatMap((services) => Effect.provideContext(program, services)),
        Effect.scoped,
        Effect.timeout('230 seconds'),
    ),
);
