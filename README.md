# 造句练习 · HSK sentence practice

Daily sentence-writing practice with a shared HSK 1?6 vocabulary list. Pick today's first word and how many new words you study per day, then write sentences with each word. DeepSeek checks them and marks three kinds of problems:

- **Target word**: how the new word is used (meaning, collocation, part of speech, position, register)
- **Grammar**: errors elsewhere in the sentence
- **Naturalness**: grammatical, but not how a native speaker would say it

Each sentence also gets a minimally corrected version and a natural rewrite.

## Grammar section

The **Grammar** tab contains a comprehensive HSK 1–6 reference catalogue, filterable by level while retaining topic groups. Its hand-written question bank drills the original intermediate connectors and sentence patterns (只要……就, 既然……就, 与其……不如, 是……的, V下去 …); every catalogue entry also supports writing practice and AI-generated questions. It works without a vocabulary list.

Level assignments follow the [official HSK syllabus released in November 2025](https://hsk.cn-bj.ufileos.com/3.0/%E6%96%B0%E7%89%88HSK%E8%80%83%E8%AF%95%E5%A4%A7%E7%BA%B21219.pdf), effective July 2026. The catalogue was cross-checked against [WordSwing's syllabus-based HSK grammar index](https://hsk.wordswing.com/grammar/).

- **Fill in (选择)**: a sentence with one or two blanks and four options. The wrong options are confusable structures or mismatched pairs (只有……就), and the target structure is not named, so you have to work out the logic.
- **Spot it (判断)**: pick the one correct sentence out of 3–4. The others contain typical learner errors (就 before the subject, 并 in the wrong place, a missing 都), or the question asks which sentence has a given meaning.
- **Order (排序)**: put three clauses in order, as in HSK 4 reading part 2.
- **Translate (翻译)**: translate an English sentence. The structure is hidden unless you ask for a hint. DeepSeek checks your answer, and a reference translation is shown.
- **Write (造句)**: write your own sentences for one meaning of a structure plus a random constraint ("different subject in each clause", "make it a question" …). DeepSeek checks them with the same colour-coded corrections as the vocabulary section.
- **Structures (语法表)**: the reference list with notes, confusable pairs, examples with pinyin, your recent sentences, and checkboxes to choose which structures you practise.

Every question can be followed up with questions to the tutor. Structures are scheduled with a simple Leitner system (a wrong answer brings a structure back within minutes, right answers push it out to 1, 2, 4, 8, 16 days), and “Due for review” in the scope menu shows only those. The built-in bank has 123 hand-written questions; **Generate new questions** asks DeepSeek for 8 more on your weakest structures. Generated questions are marked “AI” and can be removed with one click if one is wrong.

## Check page

The **Check** tab works without a vocabulary list (it still needs a DeepSeek key or the passphrase). It has two modes:

- **Check my Chinese (改错)**: any Chinese you wrote, up to 1500 characters. Optionally say in English what you meant and pick a register (casual, neutral, formal). Mistakes are marked as **grammar**, **word choice** (wrong word, collocation or measure word), **naturalness** and, only when you said what you meant, **meaning**. Each sentence gets a corrected and a natural version.
- **Explain a sentence (解释)**: Chinese you didn't write, up to 500 characters. You get the full pinyin, a natural translation, a word-by-word table (word, pinyin, meaning, role), the grammar points with an extra example each, and notes on register and idioms. It only mentions errors if the sentence clearly contains one.

Both modes have the follow-up chat. The last 100 checks and explanations are kept in a history (newest first) that can be reopened with its chat or deleted entry by entry; it is part of Settings → Backup. In passphrase mode both go through `/api/check` with `mode: "free"` or `mode: "explain"` (`/api/chat` takes the same `mode`).

## Hover dictionary

Rest the pointer on any Chinese character (or tap it on a phone) to see the word it belongs to, its pinyin and meaning, and its number if it is in your deck (your deck's pinyin and meaning are shown first). The dictionary is [CC-CEDICT](https://cc-cedict.org/wiki/) by MDBG, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). `data/cedict.txt` is a shortened derivative (simplified words up to five characters, tone-marked pinyin, the first senses of each reading; county and district names removed), distributed under the same licence. It is downloaded the first time you hover over Chinese text and kept in the browser's cache. Rebuild it with `node scripts/build-dict.mjs` (downloads the latest CC-CEDICT) or `node scripts/build-dict.mjs path/to/cedict_ts.u8`.

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

Your position, progress and past attempts are stored in your browser's localStorage; the vocabulary list is shared from the project. Use Settings → Backup to move them to another device. Only the current word or structure, your sentences and the corrections are sent to DeepSeek (via the server only in passphrase mode). Exported backups exclude the API key and passphrase. The site uses cookieless [Vercel Web Analytics](https://vercel.com/docs/analytics) for anonymous page-view counts (only the page path is sent, no app content). The shared vocabulary list is extracted from `HSK_1-6_english_chinese.apkg` into `data/vocab.json`. Use the Vocabulary tab to browse it and choose your position.
