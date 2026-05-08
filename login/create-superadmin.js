const bcrypt = require("bcrypt");

async function main() {
  const password = String(process.argv[2] || "").trim();

  if (!password) {
    console.error("Usage: node create-superadmin.js YourSuperAdminPassword");
    process.exitCode = 1;
    return;
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    console.log("Use these values in your .env file:");
    console.log(`SUPERADMIN_PASSWORD_HASH=${hash}`);
  } catch (error) {
    console.error("Unable to generate SuperAdmin password hash:", error.message);
    process.exitCode = 1;
  }
}

main();
