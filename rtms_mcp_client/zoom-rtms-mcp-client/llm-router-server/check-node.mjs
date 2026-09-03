const requiredMajor = 22;
const currentMajor = Number(process.versions.node.split('.')[0]);

if (currentMajor < requiredMajor) {
  console.error(`Node.js ${requiredMajor} or newer is required; current version is ${process.version}. Run: nvm use 22`);
  process.exit(1);
}
