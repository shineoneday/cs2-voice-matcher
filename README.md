# CS2 Voice Matcher

Extracts voice chat from CS2 demos and finds accounts that share the same voice, e.g. one player behind several SteamIDs.

> [!IMPORTANT]
> Partial source release. The processing core (demo parsing, speaker embeddings, matching, storage) is not published, so this repo does not build.

## How it works

1. A `.dem` or `.dem.zst` is uploaded.
2. Each player's Opus voice packets are decoded and split into clips on pauses.
3. A [WeSpeaker ResNet34](https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM) ONNX model turns a player's speech into a 256-dim vector.
4. Vectors for one SteamID are averaged across demos, weighted by speaking time.
5. Profiles are compared by cosine similarity. Players with under 10s of speech are skipped.
6. Accounts are grouped with complete linkage: an account joins a group only if it matches every member, so A≈B and B≈C never merges A with C.

Demos are deduplicated by SHA-256. Clips are kept as WAV, so any match can be checked by ear.

## UI

| Tab | Shows |
|---|---|
| **Upload** | demo upload and processing |
| **Matches** | account pairs above the threshold, optionally only pairs with different names |
| **Players** | search by name or SteamID, demo history, similar voices |
| **Identity Groups** | accounts likely owned by one person; confidence ≥ 0.90 high, ≥ 0.80 medium, ≥ 0.70 low |
| **Compare** | two players side by side, per-demo similarity, audio clips |

<details>
<summary><b>API</b></summary>

| Method | Path | |
|---|---|---|
| POST | `/api/upload` | upload `.dem` / `.dem.zst`, up to 1 GB |
| POST | `/api/process` | process everything in `uploads/`, returns `jobId` |
| POST | `/api/reprocess` | recompute vectors from stored WAV clips |
| GET | `/api/jobs/{id}` | job status |
| POST | `/api/import-faceit` | import a match by FACEIT link |
| GET | `/api/stats` | demo, player and match counts |
| GET | `/api/demos`, `/api/demos/{id}` | demos and their players |
| GET | `/api/matches` | pairs; `threshold`, `diffNames`, `map` |
| GET | `/api/players` | players; `search`, `minSpeaking` |
| GET | `/api/players/{steamId}` | profile and history |
| GET | `/api/players/{steamId}/similar` | similar voices; `threshold` (0.70) |
| GET | `/api/players/{steamId}/audio` | player's clips |
| GET | `/api/compare/{id1}/{id2}` | compare two players |
| GET | `/api/clusters` | identity groups; `threshold` (0.85) |
| GET | `/api/histogram` | similarity distribution |
| GET | `/api/diag/segment-test` | checks that a player's clips match each other better than other players |
| DELETE | `/api/data` | wipe everything |

</details>

## Stack

.NET 9 minimal API · SQLite · [DemoFile](https://github.com/saul/demofile-net) · Concentus (Opus) · ONNX Runtime · vanilla JS + Tailwind · Docker

## Known issues

- FACEIT import is broken: demo downloads need a Downloads API key, and the old CDN hosts no longer resolve.
- New CS2 patches can break demo parsing until DemoFile is updated.
- No auth, open CORS, and `DELETE /api/data` wipes the database. Local use only.

## Data

Voice recordings and SteamIDs are personal data. The database, audio and demos are not in this repo.

## License

None. All rights reserved: you can read the code, not reuse it.
