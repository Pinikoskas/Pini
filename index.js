const { main } = require('./src/agent');
const { forTerminal } = require('./src/terminal');

main().catch((e) => {
  console.error(forTerminal(`שגיאה: ${e.message}`));
  process.exit(1);
});
