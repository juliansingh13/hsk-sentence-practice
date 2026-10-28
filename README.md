# 造句练习 · HSK sentence practice

Daily sentence-writing practice for the new words in your Anki HSK deck. Upload an Anki export, pick today's first word and how many new words you study per day, then write sentences with each word. DeepSeek checks them and marks three kinds of problems:

- **Target word**: how the new word is used (meaning, collocation, part of speech, position, register)
- **Grammar**: errors elsewhere in the sentence
- **Naturalness**: grammatical, but not how a native speaker would say it

Each sentence also gets a minimally corrected version and a natural rewrite.

## Deploy on Vercel

1. Import this repository at https://vercel.com/new (Framework preset: **Other**, no build command).
2. Under **Settings → Environment Variables**, add:
   - `DEEPSEEK_API_KEY`: your key from https://platform.deepseek.com
   - `APP_PASSPHRASE`: any phrase; the site asks for it so strangers can't use your credit
   - optional `DEEPSEEK_MODEL` (default `deepseek-chat`)
3. Redeploy (Deployments → ⋯ → Redeploy) so the variables take effect.
4. Open the site, go to **Settings**, upload your export, choose the first word and words per day, enter the passphrase, and press **Save and start**.

## Exporting from Anki

File → Export… → **Notes in Plain Text (.txt)**, select your HSK deck, untick "Include HTML and media references". The site detects the columns. Check the mapping preview, since field order differs between decks.

## Running locally

```
cp .env.example .env    # fill in the key and passphrase
node dev-server.js      # http://localhost:3000
```

`MOCK=1` in `.env` returns sample corrections without calling DeepSeek.

## Data

The vocabulary list, progress and past attempts are stored in your browser's localStorage. Use Settings → Backup to move them to another device. Only the current word and your sentences are sent to the server and on to DeepSeek.
