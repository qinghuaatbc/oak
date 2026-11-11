#!/usr/bin/env node
// Oak's admin logins, in orchestrator/admin.json - passwords only as salted
// scrypt hashes (see orchestrator/auth.js). Asks for a username and a
// password (typed unseen, then again to confirm): a new name adds a login,
// a name already there gets the new password. The installers run this on a
// first install. Oak reads the file on every sign-in, so changes work at
// once, without a restart.
//
// Usage:
//   node scripts/set-login.js                                     add a login, or change its password
//   node scripts/set-login.js --user admin --password 'secret'    (no questions asked)
//   node scripts/set-login.js --remove NAME                       remove one - never the last
//   node scripts/set-login.js --list                              the usernames
"use strict";
const readline = require("readline");
const { makeLogin, storedLogins, saveLogins, ADMIN_FILE } = require("../orchestrator/auth.js");

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
      // (Echo the question itself, but not the keys typed after it. _writeToOutput
      // is readline's own internal hook - there is no public way to do this.)
      /** @type {any} */ (rl)._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function list() {
  const logins = storedLogins();
  if (!logins.length) console.log("No logins yet (node scripts/set-login.js adds one).");
  for (const l of logins) console.log(l.username);
}

function remove(name) {
  const logins = storedLogins();
  const at = logins.findIndex((l) => l.username === name);
  if (at < 0) {
    console.error(`There is no login "${name}" (--list shows them).`);
    process.exit(1);
  }
  if (logins.length === 1) {
    console.error(`"${name}" is the only login, and there must be one: add another first, or give this one a new password.`);
    process.exit(1);
  }
  logins.splice(at, 1);
  saveLogins(logins);
  console.log(`Removed "${name}" (${ADMIN_FILE}, ${logins.length} login(s) left).`);
}

async function main() {
  if (args.includes("--list")) return list();
  if (args.includes("--remove")) {
    const name = flag("--remove");
    if (!name) {
      console.error("usage: node scripts/set-login.js --remove NAME");
      process.exit(1);
    }
    return remove(name);
  }
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
  // A new name is added; a known one gets the new password.
  const logins = storedLogins();
  const at = logins.findIndex((l) => l.username === username);
  if (at >= 0) logins[at] = makeLogin(username, password);
  else logins.push(makeLogin(username, password));
  saveLogins(logins);
  const what = at >= 0 ? "Password changed" : "Login added";
  console.log(`${what} for "${username}" (${ADMIN_FILE}, ${logins.length} login(s)). It works at once - no restart needed.`);
}

main();
