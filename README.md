# 造句练习 · HSK sentence practice

Daily sentence-writing practice for the new words in your Anki HSK deck. Upload an Anki export, pick today's first word and how many new words you study per day, then write sentences with each word. DeepSeek checks them and marks three kinds of problems:

- **Target word**: how the new word is used (meaning, collocation, part of speech, position, register)
- **Grammar**: errors elsewhere in the sentence
- **Naturalness**: grammatical, but not how a native speaker would say it

Each sentence also gets a minimally corrected version and a natural rewrite.

## How the AI calls work

Each visitor adds their own DeepSeek API key in Settings. It is stored only in their browser and the page calls `api.deepseek.com` directly, so the key never reaches this site's server.

Optionally, the site owner can share their own key: set `DEEPSEEK_API_KEY` and `APP_PASSPHRASE` in Vercel, and anyone who enters the passphrase (with the key field left empty) uses the owner's key through the `/api` functions. Without those variables the functions refuse requests and only own-key mode works.

## Deploy on Vercel

1. Import this repository at https://vercel.com/new (preset **Other**, no build command).
2. Optional, for the shared-key mode: under **Settings → Environment Variables** add `DEEPSEEK_API_KEY`, `APP_PASSPHRASE` and optionally `DEEPSEEK_MODEL` (default `deepseek-chat`), then redeploy.
3. Share the link. Visitors follow the steps on the Settings page.

## Exporting from Anki

File → Export… → **Notes in Plain Text (.txt)**, select your HSK deck, untick "Include HTML and media references". The site detects the columns. Check the mapping preview, since field order differs between decks.

## Running locally

```
cp .env.example .env    # fill in the key and passphrase
node dev-server.js      # http://localhost:3000
```

`MOCK=1` in `.env` returns sample corrections without calling DeepSeek.

## Data

The vocabulary list, progress and past attempts are stored in your browser's localStorage. Use Settings → Backup to move them to another device. Only the current word, your sentences and the corrections are sent to DeepSeek (via the server only in passphrase mode). Exported backups exclude the API key and passphrase.
