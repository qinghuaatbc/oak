#!/usr/bin/env node
// Sets Oak's admin login: asks for a username and a password (typed
// unseen, then again to confirm) and writes orchestrator/admin.json - the
// password only as a salted scrypt hash (see orchestrator/auth.js). The
// installers run this on a first install; run it yourself any time to
// change the login. Oak reads the file on every sign-in, so the new login
// works at once, without a restart.
//
// Usage:
//   node scripts/set-login.js
//   node scripts/set-login.js --user admin --password 'secret'   (no questions asked)
"use strict";
const fs = require("fs");
const readline = require("readline");
const { makeLogin, ADMIN_FILE } = require("../orchestrator/auth.js");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Asks a question on the terminal; `hidden` shows nothing as the answer is typed. */
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // (Echo the question itself, but not the keys typed after it.)
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  let username = flag("--user");
  let password = flag("--password");
  if (username === undefined) username = (await ask("Oak username [admin]: ")).trim() || "admin";
  if (password === undefined) {
    for (;;) {
      password = await ask("Oak password: ", true);
      if (!password) {
        console.log("The password can't be empty - try again.");
        continue;
      }
      if ((await ask("Again, to confirm: ", true)) === password) break;
      console.log("Those didn't match - try again.");
    }
  }
  if (!username || !password) {
    console.error("Both a username and a password are needed.");
    process.exit(1);
  }
  // (Readable by this user only.)
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(makeLogin(username, password), null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(ADMIN_FILE, 0o600);
  console.log(`Login saved for "${username}" (${ADMIN_FILE}). It works at once - no restart needed.`);
}

main();
