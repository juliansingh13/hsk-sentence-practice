# 造句练习 · HSK sentence practice

Daily sentence-writing practice for the new words in your Anki HSK deck. Upload an Anki export, pick today's first word and how many new words you study per day, then write sentences with each word. DeepSeek checks them and marks three kinds of problems:

- **Target word**: how the new word is used (meaning, collocation, part of speech, position, register)
- **Grammar**: errors elsewhere in the sentence
- **Naturalness**: grammatical, but not how a native speaker would say it

Each sentence also gets a minimally corrected version and a natural rewrite.

## Grammar section

The **Grammar** tab drills 53 HSK 3–5 connectors and sentence patterns (只要……就, 既然……就, 与其……不如, 是……的, V下去 …). It works without a vocabulary list.

- **Fill in (选择)**: a sentence with one or two blanks and four options. The wrong options are confusable structures or mismatched pairs (只有……就), and the target structure is not named, so you have to work out the logic.
- **Spot it (判断)**: pick the one correct sentence out of 3–4. The others contain typical learner errors (就 before the subject, 并 in the wrong place, a missing 都), or the question asks which sentence has a given meaning.
- **Order (排序)**: put three clauses in order, as in HSK 4 reading part 2.
- **Translate (翻译)**: translate an English sentence. The structure is hidden unless you ask for a hint. DeepSeek checks your answer, and a reference translation is shown.
- **Write (造句)**: write your own sentences for one meaning of a structure plus a random constraint ("different subject in each clause", "make it a question" …). DeepSeek checks them with the same colour-coded corrections as the vocabulary section.
- **Structures (语法表)**: the reference list with notes, confusable pairs, examples with pinyin, your recent sentences, and checkboxes to choose which structures you practise.

Every question can be followed up with questions to the tutor. Structures are scheduled with a simple Leitner system (a wrong answer brings a structure back within minutes, right answers push it out to 1, 2, 4, 8, 16 days), and “Due for review” in the scope menu shows only those. The built-in bank has 123 hand-written questions; **Generate new questions** asks DeepSeek for 8 more on your weakest structures. Generated questions are marked “AI” and can be removed with one click if one is wrong.

Pinyin is generated in the browser by [pinyin-pro](https://github.com/zh-lx/pinyin-pro) (MIT), bundled in `js/vendor/`.

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

The vocabulary list, progress and past attempts are stored in your browser's localStorage. Use Settings → Backup to move them to another device. Only the current word or structure, your sentences and the corrections are sent to DeepSeek (via the server only in passphrase mode). Exported backups exclude the API key and passphrase.
