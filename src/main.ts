export async function run(): Promise<void> {}

const isEntry = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  run().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
