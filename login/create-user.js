const bcrypt = require("bcrypt");
require("dotenv").config();

const pool = require("./db");

async function createUser() {
  try {
    const email = "admin@voxscribe.com";
    const plainPassword = "Admin@123";

    const passwordHash = await bcrypt.hash(plainPassword, 12);

    const result = await pool.query(
      `INSERT INTO app_user (email, password_hash, is_active)
       VALUES ($1, $2, $3)
       RETURNING id, email`,
      [email.toLowerCase(), passwordHash, true]
    );

    console.log("User created:", result.rows[0]);
  } catch (error) {
    console.error("Create user error:", error.message);
  } finally {
    await pool.end();
  }
}

createUser();