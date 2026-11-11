# Printer — simple Telegram bot account management

This version does NOT use MongoDB, Telegram API ID/hash, a Telegram user session, or a Telegram storage channel.

## What you need
1. `BOT_TOKEN` from @BotFather.
2. `ADMIN_TELEGRAM_IDS` — your numeric Telegram user ID (for example from @userinfobot).
3. `INITIAL_ADMIN_PASSWORD` — the password you choose for the website's first admin login.

Render generates `SESSION_SECRET` automatically from `render.yaml`.

## Deploy with Render Blueprint
1. Upload the contents of this folder to the root of a GitHub repository.
2. In Render choose **New → Blueprint**, connect the repository, and deploy.
3. Render reads `render.yaml`.
4. Enter `BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, and a strong `INITIAL_ADMIN_PASSWORD` when prompted.
5. This Blueprint uses a paid Starter web service and a 1 GB persistent disk mounted at `/var/data`. The disk is important: Render's normal ephemeral filesystem can lose JSON accounts during redeploys/restarts.
6. Once deployed, open the service URL. Website admin login is `admin` and the password you entered as `INITIAL_ADMIN_PASSWORD`.

## Bot commands (send them in a private chat with your bot)
- `/start` or `/help`
- `/adduser username password days` — `0` means no expiry
- `/users`
- `/delete username`
- `/disable username`
- `/enable username`
- `/resetpass username newpassword`

Only Telegram numeric IDs listed in `ADMIN_TELEGRAM_IDS` may use bot commands. If multiple admins, separate IDs with commas.

Passwords are stored as hashes in `/var/data/users.json`, not as plaintext. Bot commands containing passwords may remain in your Telegram chat history; use a private chat and delete command messages after use.

## Notes
- This changes account storage and bot management only. Printer/TikTok live functions still depend on the separate original backend APIs and may not work if those APIs were not included in the source ZIP.
- Keep your bot token private. If exposed, revoke it through @BotFather.
