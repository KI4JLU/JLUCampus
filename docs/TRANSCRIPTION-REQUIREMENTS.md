# Transcription requirements

## 1) Overview

Port the transcription service of [kiChat test](https://ki-test.hrz.uni-giessen.de/transcript) into the JLU Campus app as a native singleton module. This document defines the reference behavior and the proposed Campus integration. It is a review checklist for implementation and equivalence review, not authorization to change the reference account or deploy a backend.

Research took place on 4 October 2026, Europe/Berlin. The reference account was the owner-provided test account. No password, recovery key, provider API key, cookie, or signed storage credential is included here. Screenshots and research artifacts are outside the repository in `/tmp/transcription-ref/`.

Evidence labels used throughout:

- **Live** means an authenticated HTTP response or an interaction with the reference UI was observed.
- **Source** means the deployed frontend explicitly implements the behavior. It does not prove that the backend accepts every option or that the workflow succeeds.
- **Proposal** means a Campus implementation choice. It must not be cited as a kiChat fact.
- **Unresolved** means a reviewer needs additional reference access or a product decision. Section 7 lists these gaps.

A material access constraint applies to every UI observation. Login succeeded, but normal navigation redirected to `/handshake`, asking for the encrypted-chat recovery code on this unfamiliar browser. The account owner has not supplied that code. Authenticated `GET /transcript` and the transcription APIs still returned the actual page and data. For research, the browser rendered that server-provided page after suppressing only its shared client-side `window.location.href = '/handshake';` redirect. Authentication, server authorization, API responses, and stored data were unchanged. Dynamic English labels were initialized from the actual English page's translation map after switching the account language. This instrumentation enabled a real transcription; it prevents claiming that normal recovery-code-free navigation, all global navigation handlers, or every narrow-layout interaction was verified. Do not rebuild the chat encryption barrier as part of transcription.

### Evidence and reproduction

The primary sources are the live page and its deployed JavaScript:

| Alias | Deployed source | Principal responsibility |
| --- | --- | --- |
| App | [TranscriptApp.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/TranscriptApp.js) | State, initialization, global bindings |
| UI | [TranscriptUI.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/TranscriptUI.js) | Upload queue, grouping, analysis, dispatch, restored jobs, player |
| Service | [TranscriptService.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/TranscriptService.js) | Provider settings |
| History | [HistoryManager.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/HistoryManager.js) | History, detail loading, titles, subtitles, deletion |
| Processor | [SegmentProcessor.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/SegmentProcessor.js) | Speaker blocks, corrections, redaction, undo, persistence |
| Export | [ExportManager.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/ExportManager.js) | Export formats, transcript presets, summary templates and editor |
| Utils | [Utils.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/Utils.js) | Text masking and subtitle construction |
| Recording | [LiveTranscriptionManager.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/LiveTranscriptionManager.js) | Microphone, local recordings, live transcript presentation |
| Realtime | [realtime_transcription.js](https://ki-test.hrz.uni-giessen.de/js/modules/realtime_transcription.js) | WebRTC and realtime transcription protocol |
| Players | [WaveformAudioPlayer.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/WaveformAudioPlayer.js), [CustomAudioPlayer.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/CustomAudioPlayer.js) | Waveform, timing, snippet playback |
| Selection | [CustomSelectionHandles.js](https://ki-test.hrz.uni-giessen.de/js/modules/transcript/CustomSelectionHandles.js) | Touch selection handles |

Copies of these sources, a sanitized network HAR, response observations, export bytes, and screenshots are in the research directory. Source URLs may change after this observation date. Prefer the captured copies for a stable comparison. The HAR omits page bodies and redacts credential fields; it is not needed by the Campus runtime.

A real end-to-end run used an `espeak-ng` German WAV, mono PCM, 22,050 Hz, 495,752 bytes, 11.240544 seconds. Spoken text was "Guten Tag. Dies ist ein kurzer Test der Transkription für die Universität Gießen. Wir treffen uns am Montag um zehn Uhr. Vielen Dank." The file was selected, uploaded to signed object storage, automatically analyzed, assigned the speaker name "Test speaker", dispatched with automatic language and speaker count plus LLM correction enabled, completed, and persisted to history. The backend returned German text with "10 Uhr". The result had one segment from 0 to 10.72 seconds and no word-level items. The saved record reported duration 11, `model_used: "jlu/whisper-1"`, and `provider: "custom_speaches"`. An AI subtitle became "Transkriptionstest der Universität Gießen mit Terminvereinbarung".

A summary was generated, the transcript and subtitle were renamed, a text correction and redaction/undo were saved, a custom transcript format and two custom summary templates were created, and a real AI section preview returned results. PDF, Markdown, text, SRT, VTT, and JSON exports produced bytes. DOCX was offered and its client library loaded, but generation stayed pending in this instrumented browser; successful DOCX download is unresolved. An invalid 17-byte WAV produced a real diarization-server 415 failure. Unsupported-extension and over-size rejection were exercised without uploading a huge file.

Cleanup was verified with authenticated reads: history `[]`, active jobs `[]`, custom formats `[]`, five built-in summary templates only, and the test transcript detail returned 404. Both uploaded jobs were deleted. German account language was restored. Physical object erasure cannot be independently verified.

### Screenshot index

All filenames below resolve under `/tmp/transcription-ref/`. They are evidence, not assets to bundle into Campus.

| Files | What they show |
| --- | --- |
| `01-device-handshake.png` | Actual recovery-code barrier |
| `03-choice-de.png`, `21-choice-en.png` | Entry choices |
| `04-upload-empty-de.png`, `22-upload-en.png` | Upload settings and empty state |
| `05-analysis-ready-de.png`, `06-speaker-mapping-de.png`, `07-transcribing-de.png` | Analysis, speaker naming, processing |
| `08-result-preview-de.png`, `09-corrections-de.png`, `23-result-en.png` | Result and correction modes |
| `10-export-summary-empty-de.png`, `11-summary-generating-de.png`, `12-summary-result-de.png` | Summary empty/loading/result |
| `13-transcript-formatting-de.png`, `24-formatting-en.png` | Transcript export settings |
| `14-summary-templates-de.png`, `15-template-editor-de.png` | Template library and editor |
| `16-redaction-de.png` | Redaction and correction tools |
| `17-record-empty-de.png`, `18-live-empty-de.png`, `26-record-en.png`, `27-record-error-en.png` | Recording/live modes and permission failure |
| `28-grouped-uploads-en.png`, `30-analysis-failed-en.png` | Grouped queue and failed audio analysis |
| `20-live-mobile-de.png`, `29-upload-mobile-en.png`, `31-result-mobile-expanded-en.png`, `32-result-mobile-collapsed-en.png` | 390 × 844 narrow-layout probes, with the instrumentation caveat above |
| `33-delete-confirmation-en.png` | History deletion confirmation |

`02-chat-navigation.png` is another handshake image, `19-microphone-error-de.png` does not visibly expose the error, and `25-provider-settings-en.png` does not show a provider dialog. Do not use these filenames as evidence for the functionality implied by their names.

## 2) Observed feature inventory

Each item is an equivalence acceptance test. Implementers must preserve the demonstrated outcome and source-defined behavior or document an approved deviation. Source-only and unresolved items remain pending reference validation; a tick must not imply they were live-tested here. Section 4 supplies the exact text catalog for these tests.

### Entry, upload, and queue

- [ ] **T-01. Service entry and workspace modes.** Live page/source. The sidebar microphone entry targets `/transcript`. The initial workspace offers upload and recording; recording contains regular recording and live transcription tabs. Acceptance: users can enter all three workflows, return to the choice screen, and start a new transcription without a completed result being required. New/choice clears the current selection when safe and clears the history search. Evidence: App, UI `showTranscriptChoice`, screenshots 03/21.
- [ ] **T-02. German and English UI.** Live. Global settings change the account locale through `/req/changeLanguage`, followed by reload. Acceptance: both locales expose the same controls and states; automatic speaker labels localize while user-entered names remain unchanged. Preserve exact catalog values in section 4 for reference comparison. Hardcoded strings and German server errors are exceptions documented there. Evidence: screenshots 21–24/26–30, UI `localizeAutoSpeakerLabel`.
- [ ] **T-03. Multi-file chooser and drag/drop.** Live controls/source. The file input accepts multiple selections and the upload area accepts dropped files. Its HTML `accept` attribute is empty; validation happens after selection. Acceptance: selecting or dropping several supported files creates individual queue rows; adding more to an existing group does not replace its files. Evidence: UI `handleFileSelect`, `bindFileDragAndDrop`, screenshots 04/28.
- [ ] **T-04. Exact file validation and limits.** Live rejected fixtures/source. A file passes if its MIME is one of `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/m4a`, `audio/ogg`, `video/mp4`, OR its case-insensitive filename extension is `mp3`, `wav`, `m4a`, `mp4`, or `ogg`. Maximum is `500 * 1024 * 1024` bytes per file, inclusive. Acceptance: reject an unsupported `.txt` and a supported-name file at 524,288,001 bytes before upload, with the catalog alert. Accept the size boundary in validation. MP4 is accepted by code despite being omitted from the four-extension helper text. Successful MP4 decoding and the server size boundary are unresolved. No frontend count, aggregate-size, or duration ceiling was found.
- [ ] **T-05. Duplicate handling and metadata.** Source; WAV metadata live. Duplicate identity is filename + byte size + `lastModified` within the destination group. Acceptance: duplicate selection in that group adds no row; other distinct files remain. Display filename, formatted bytes, local audio duration, aggregate count and size. A restored server job need not have a browser File or accurate byte count. Evidence: UI `handleFileSelect`, `renderMultiFileSelection`.
- [ ] **T-06. Transcript groups.** Live controls/source. Groups default to `Transcript 1`, `Transcript 2`, etc., have editable names, per-group add-file and delete actions, and an add-group action. Acceptance: group names survive local edits, empty groups are cleaned up/renumbered, and one successful group produces one history transcript, even with several source files. A completed group's result link opens its saved transcript. Evidence: UI group methods, screenshots 28.
- [ ] **T-07. File ordering and movement.** Live published handler/source. Drag handles reorder files within a group and move files between groups; external drops target the group. Acceptance: resulting playback/transcript ordering follows queue order; processing and completed groups reject incompatible changes. The invalid WAV was moved to a second group during research. Evidence: UI `moveFile`, `bindFileDragAndDrop`.
- [ ] **T-08. Queue removal and cancellation.** Source; backend cleanup live. Removing an uploaded file confirms deletion and calls the job DELETE endpoint before dropping the row. Group deletion cancels/deletes every associated job; any failure leaves the group available rather than pretending all data was removed. Acceptance: cancel leaves rows intact, confirmation removes on backend success, and failure shows an error. Source: UI `removeFileFromGroup`, `removeGroup`.
- [ ] **T-09. Upload settings.** Live. Language choices are automatic, German, English with values `auto/de/en`; speaker-count choices are automatic, one speaker, multiple speakers with values `auto/single/multi`. LLM correction is enabled by default and can be disabled. Acceptance: all choices are editable before dispatch and the correction flag changes from 1 to 0 in the dispatch request. There is no visible numeric speaker count, arbitrary batch prompt, or arbitrary language selector. The propagation of a language change after automatic session creation is unresolved.
- [ ] **T-10. Automatic upload and analysis.** Live. Selection immediately creates an upload session, PUTs the bytes, and requests speaker analysis; pressing the later start button is not required for these steps. Acceptance: show per-file upload progress, then speaker-analysis progress, then ready/failed state; store the returned job ID on the row. A successfully uploaded source is reused for dispatch. Evidence: screenshot 05, section 3 trace.
- [ ] **T-11. Queue status and progress.** Live/source. Rows show progress percentage, status text, ready/processing/error/success styling, and overall processing state. Upload progress occupies the early portion, analysis has estimated progress, backend chunk/phase progress drives later display. Acceptance: zero backend chunk totals do not divide by zero; pending work disables conflicting operations; completion and failure stop progress. Treat animated progress creep as an estimate, not measured backend percentage. Screenshots 05/07/30.
- [ ] **T-12. Preview queued audio.** Live controls/source. Each local source has waveform/playback, duration and seeking before dispatch. Acceptance: play/pause and seek operate independently of transcription; removal destroys the player's local resources. Source: UI, Players.
- [ ] **T-13. Start, parallel files, sequential groups, and retry.** Real single-file run/source for multi-file. Starting processes groups sequentially and files within a group concurrently. Acceptance: dispatch each unfinished file only once, reuse a file's cached successful result after partial failure, save the group after its files succeed, and report failed files without silently saving a complete group. Do not infer a backend concurrency quota from frontend `Promise.all`. Source: UI `startTranscription`.
- [ ] **T-14. Concatenate group results.** Source. Merge text, segments, words, and source-file metadata in file order. Offset later segment/word timestamps by cumulative result duration, falling back to each result's last segment end, then zero. Round saved total duration. This differs from actual audio duration when trailing silence is omitted. Acceptance: two fixtures with identifiable speech yield one result with monotonic global timing and source ranges `{start_time,end_time}`. Group title is used when saving and renaming a completed group updates its linked transcript title. Source: UI `startTranscription`, `syncGroupTranscriptionsTitle`.
- [ ] **T-15. Restore active jobs.** Live empty endpoint/source restoration. On initialization fetch active jobs. Deduplicate by job ID; resume analysis or transcription polling without uploading or dispatching again. Acceptance: analyzed jobs restore mapping data, ongoing jobs restore status, completed restored jobs get saved and disappear from the active listing. Reference grouping does not survive reload: each restored job becomes its own group with filename-derived title, size 0, and no local waveform. Source: UI `restoreJobIntoQueue`, `resumeTranscriptionPolling`. Non-empty reload restoration remains untested.
- [ ] **T-16. Batch failure and retry states.** Invalid WAV live/source. The invalid WAV reaches `failed` with a diarization-server 415 message; the row shows failure. Acceptance: display the failed row, preserve other work, allow deletion, stop polling terminal failure, and expose appropriate failure/retry feedback for upload/session/analyze/dispatch/save errors. Uploads have distinct session failure, storage HTTP-status/network/abort errors; analysis/dispatch failures can leave only a failed row while detailed errors are console-only. Do not assert every backend diagnostic is visible in a modal. No proof of rate-limit behavior was obtained. Exact error catalog is in section 4; this run's raw backend error is in section 3.

### Speaker analysis and mapping

- [ ] **T-17. Speaker analysis and unresolved names.** Live. Analysis returns speaker IDs, localized default voice labels, timestamps and short playable samples. Rows show unidentified-speaker counts and offer naming/adjustment. Acceptance: one voice from the fixture appears, unresolved count falls when a user assigns a name, and a named speaker survives dispatch/result. Screenshot 06; UI `getUnidentifiedSpeakersCount`.
- [ ] **T-18. Mapping dialog.** Live controls/source. The dialog lists analyzed voices, editable names and a ten-color avatar picker. It orders voices by their detected start and plays their samples. Acceptance: save updates mapping, snippets and colors, gives saved feedback and closes; reopening shows saved local mapping; close without a successful save must not imply server persistence. Mapping is sent with dispatch, not a separate name-save API. Source: UI `openSpeakerMappingModal`, `showAvatarPicker`.
- [ ] **T-19. Sample editing and selection.** Live controls/source. Open a sample's detail panel, play/pause, select or drag its audio window, edit its label/start/end, add another sample, or delete one with a two-step confirm/cancel control. Source clamps the selection to a minimum 0.2 seconds and maximum five seconds within media bounds. Dragging past the maximum slides the whole window; start/end values round to two decimal places. Acceptance: valid edits change dispatch snippets, invalid windows are rejected/clamped by the source-defined controls, and cancelling deletion preserves the sample. Source: UI mapping and snippet handlers. Boundary behavior for all audio lengths needs a multi-speaker fixture.
- [ ] **T-20. Add and remove voices.** Source/dialog controls. Manual voices can be added and removed, with two-step removal confirmation and matching mapping cleanup. Manual snippet construction supports timestamps in seconds or `mm:ss` and IDs derived from the manual voice. Acceptance: a new name/sample appears in dispatch; deleting it clears its mapping and sample; cancel does neither. A separate legacy manual-entry path exists in source but was not proven reachable in the current rendered page.
- [ ] **T-21. Repeat analysis and expiring samples.** Source. Re-analyze from the mapping UI with loading/disabled state; poll until analyzed or failed. For restored/old jobs, refresh speaker sample URLs when presigned expiry is within five minutes. Acceptance: successful repeat analysis replaces samples without stale playback; failure preserves a recoverable state. Source: UI `retrySpeakerAnalysis`, `refreshSpeakerAudioUrls`, `presignedUrlExpiresSoon`.

### Results, corrections, and persistence

- [ ] **T-22. Saved result workspace.** Live. A result has title, subtitle, save control, Preview, Corrections and Export views. Preview is read-only; Corrections exposes editing; Export presents the generated output and hides shared audio controls. Acceptance: switching views retains the current transcript and edits. Screenshots 08/09/23.
- [ ] **T-23. Title and subtitle editing.** Live. Inline title/subtitle editing commits on Enter/blur and Escape cancels; history context actions can rename too. Workspace title and subtitle inputs have `maxLength=255`; history context-menu title input has `maxLength=35`. Empty workspace title restores the old title; history blank input also keeps the old value. Titles PATCH independently of segments; subtitle has a separate endpoint. Acceptance: a rename is visible in workspace/history after reloading; manual subtitle persists; backend failure does not falsely confirm save. AI subtitle/title metadata are asynchronously refreshed for up to five attempts at two-second intervals. Exact title generation policy when a custom group title is supplied is unresolved. Source: History.
- [ ] **T-24. Global result playback and timing.** Live controls/source. Global audio playback has waveform, play/pause, seek, elapsed time, colored speaker timeline, active-block highlight and auto-scroll. Block/avatar playback seeks/plays that section. Acceptance: global time aligns with concatenated source ranges and clicking a transcript timestamp seeks to that block. History obtains fresh source URLs by job ID. Source skips full waveform decoding above 100 MiB while retaining playable audio. Source: UI `initGlobalAudioPlayer`, Players.
- [ ] **T-25. Speaker blocks and fallback rendering.** Live one-speaker/source. Consecutive segments with the same named speaker form blocks. Unknown-speaker grouping splits after a gap over three seconds or span over 45 seconds. Names have stable ten-color avatars. Acceptance: mixed fixtures group correctly and no-segment fallback text still displays with a default person/timestamp. Unknown-speaker and placeholder text has hardcoded localization exceptions. Source: Processor `formatTranscriptionWithSpeakers`.
- [ ] **T-26. Speaker panel and focus.** Live controls/source. Show/hide the speaker tools panel, list names/avatars, click a voice to focus its first occurrence, solo a speaker, and show all again. Acceptance: toggling a solo changes visible transcript content without deleting segments; selected and active playback states are distinct. Source: Processor `populateSpeakerPanel`, `toggleSoloSpeaker`, UI tab-shared elements.
- [ ] **T-27. Text correction.** Live save/source. Correction mode edits segment text inline; Enter commits with line breaks removed. Empty text becomes the reference placeholder. Editing clears that segment's prior redaction offsets. Acceptance: the detail API returns corrected text after reload, editing is unavailable in Preview, and offsets cannot mask unintended newly edited text. Automated `fill` duplicated text in the research contenteditable, so that artifact is not evidence of a reference defect. Source: Processor `updateSegmentText`.
- [ ] **T-28. Rename and color speakers globally.** Source; mapping name live. Rename an existing speaker inline/from the speaker panel and choose avatar colors. Acceptance: all segments with that speaker name update, color metadata persists, and user names remain untranslated across locale changes. Source: Processor rename methods, UI avatar picker. Campus deviation: a rename from the block header keeps the speaker's colour, the same as a rename from the speaker panel (`renameSpeaker` in `segments/edit.ts` moves the colour entry to the new name unless that name already has a colour). In kiChat only the panel rename (`confirmRenameSpeakerGlobal`) copies the `speakerColorMap` entry. The block-header rename (`confirmRenameSpeaker`) changes only the segments, so the new name gets the next colour (`speakerMap.size % 10 + 1`); verified 2026-10-07: "Stimme 2" (colour 2) renamed from the block became colour 3. Campus keeps one rule for both entry points because a rename should not look like a different person (recommended by the comparison; needs PO confirmation). For exact parity, give `renameSpeaker` an option that drops the old colour entry without copying it, and use it only from the block header.
- [ ] **T-29. Reassign/remove block speaker.** Source. A block can be assigned to an existing or newly created voice. Removing a block speaker assigns/merges into the previous block, or next if first, and refuses removal of the only remaining block. Acceptance: text and timing survive reassignment; single-block refusal shows catalog feedback; structural changes can be undone. Source: Processor `reassignSpeaker`, `removeSpeaker`.
- [ ] **T-30. Insert a speaker block.** Source. Insert existing/new voice before or after a block, creating `[Dieser Sprecher hat noch keinen Text!]` at the boundary with a one-second interval. Acceptance: insertion offers both positions, produces an editable placeholder, preserves existing text/times, and handles orphaned placeholders. The reference does not retime existing audio when adding this placeholder. Source: Processor insertion and cleanup methods.
- [ ] **T-31. Selection and partial speaker correction.** Source; selection/redaction live. Mouse selection and custom touch handles expose contextual actions. Moving selected text to the previous/next neighboring speaker can split a segment, deriving split timing in proportion to character offsets. Acceptance: preserve concatenated text, create correct assignments and split intervals, reject invalid/no selection, and hide the toolbar after completion. `moveSegment` changes attribution; it is not arbitrary chronological reordering. Source: Processor `moveSegment`, Selection.
- [ ] **T-32. Copy blocks and export previews.** Live controls/source. Copy a transcript block or selected export preview. Text copy gives brief copied feedback, approximately two seconds; Markdown copies source while rich previews normally copy visible plain text. Acceptance: clipboard contains the selected block/output, no hidden controls, and copy failures are reported. Source: UI `copyBlockText`, Export `triggerExportCopy`.
- [ ] **T-33. Redaction.** Live persisted redaction/undo/source. Mark selected text; record per-segment `{start,end}` character ranges, trim whitespace and merge touching/overlapping ranges. The correction panel lists redactions, truncates long entries to 57 characters plus `...`, supports single removal and clear-all. Acceptance: redaction conceals text visually, persists on reload, and text exports replace the range with `[AUSGEBLENDET]`. Clearing restores text without data loss. Raw source text remains stored and JSON retains it; redaction is not destructive erasure. Screenshot 16; Processor, Utils.
- [ ] **T-34. Undo.** Live redaction undo/source. Keep up to ten in-memory segment snapshots for structural attribution/redaction changes. Acceptance: undo restores segment contents and redactions, saves the restoration, disables at an empty stack, and resets on a new loaded transcript. No redo was found. Ordinary text correction does not push an undo snapshot in the reference. Source: Processor `pushToUndo`, `undoLastMove`.
- [ ] **T-35. Save feedback and persistence.** Live. Segment/color changes autosave with PATCH; the save control reflects pending, saved and failed state and can await an active save promise. Acceptance: a fresh detail load matches a successful edit, pending state prevents false success, and errors remain visible/retryable. Source: Processor `saveCurrentSegmentsToServer`, UI `updateSidebarSaveButtonState`.
- [ ] **T-36. AI speaker optimization.** Source/control. An action POSTs current segments, disables itself and shows running state; success replaces segments, creates an undo snapshot, rerenders/autosaves, and shows success dialog. Acceptance: error restores enabled state and shows the optimization error, success is undoable. Actual endpoint output was not tested; do not assume a specific optimization model. Source: Processor `optimizeSpeakersWithAI`.

### History

- [ ] **T-37. History list and dates.** Live list/source date groups. History is newest first by updated time with created/local fallbacks, grouped into Today, Yesterday, Last seven days and Older. Acceptance: a saved transcript appears with its title, empty sections disappear, and the no-history state is usable. No pagination was observed. Source: History; screenshots 08/23.
- [ ] **T-38. Search.** Live control/source. Case-insensitive trimmed search matches titles, not full transcript text. Acceptance: partial title finds the entry, an unmatched search hides all entries and empty date categories, clearing restores date grouping, and starting new work clears search. Source: History search methods.
- [ ] **T-39. Detail loading and local fallback.** Live detail/source. Server history is authoritative, with localStorage fallback `transcriptionHistory` preserving local-only records. Retry a transient history fetch once after 250 ms; ignore stale async render responses. Detail accepts segments as an array or JSON string. Acceptance: 404/410 removes stale local server-backed records instead of resurrecting them; a transient network failure can use local fallback. Source: History.
- [ ] **T-40. Rename/delete history.** Live rename and confirmed deletion. Context actions rename or delete. Deletion asks for confirmation, DELETEs the record, removes it from the list and returns active workspace to entry choice. Acceptance: cancel preserves it; confirmed deletion makes detail return 404. Audio-job physical deletion and record deletion are separate observed APIs, so cascade semantics remain unresolved. Screenshot 33. Source: History `requestDeleteTranscription` does not check DELETE success before removing the row; Campus should fix that as a proposal, not silently claim it is observed success handling.

### Export and summary

- [ ] **T-41. Export categories, formats and filenames.** Live/source. Categories are summary, transcript, subtitles and JSON. Summary/transcript offer DOCX, PDF, Markdown and TXT, default DOCX; subtitles offer SRT/VTT, default SRT; JSON has a fixed format. Acceptance: switching updates preview, format selector, footer, copy and download state. Downloads use `transkription-<transcript-slug>.<extension>`. PDF/Markdown/TXT/SRT/VTT/JSON generated bytes in research. Successful DOCX remains an open validation item. Source: Export.
- [ ] **T-42. Browser-generated files.** Live/source. Export runs locally from current data with browser Blob downloads, `docx` Packer and jsPDF. Acceptance: plain files are UTF-8, JSON is two-space formatted, PDF and DOCX contain the selected output. Source DOCX maps H1/H2/H3 to 18/14/12 pt runs, supports bold/italic/underline/monospace inline runs and bullet/number prefixes, but does not construct native tables from Markdown table rows. PDF uses Helvetica, 20 mm margins on default A4, heading sizes 18/14/12 pt, body 11 pt, line wrapping and page breaks around y=270 mm; inline Markdown markers are stripped. Browser preview tables are rich HTML, while document export can retain table pipe text. For non-summary documents the title is prepended; Markdown summaries already carry their own headings. Do not require byte-identical PDF/LLM output. Native File System save integration was not observed. Source: Export `triggerExportDownload`, `generateDocxBlob`, `generatePdfBlob`.
- [ ] **T-43. Transcript formatting.** Live controls/source. Options control speaker names, timestamps, avatars, chat bubbles, anonymized names, chronological/speaker grouping, and per-speaker inclusion chips. Acceptance: preview changes immediately; a hidden speaker is omitted from formatted transcript output; anonymization produces numbered generic names consistently in encounter order; source segments remain unchanged. These settings do not filter raw JSON. Source: Export `exportToVerlauf`, screenshots 13/24.
- [ ] **T-44. Transcript presets.** Live controls/source. Five built-ins set the exact flags in the table below. Acceptance: choosing any preset sets every flag, custom changes mark the format custom, and switching back restores those preset values. Source: Export constructor, `selectTranscriptPreset`.
- [ ] **T-45. Save/update/delete custom formats.** Live create/delete/source. Require trimmed non-empty format name; case-insensitive duplicate naming uses numbered suffixes. Persist names/timestamps/avatars/bubbles/anonymize/order with a server ID; updating uses that ID and deleting uses its endpoint. Visible-speaker selection is not stored in a preset. Acceptance: reload offers saved formats and uses their flags; cancelled/failed changes do not pretend persistence. Legacy localStorage format migration exists in source and sends old formats to the server; preserve equivalent access to existing preferences if migrating users. Source: Export custom-format methods.
- [ ] **T-46. Subtitles.** Live actual SRT/VTT/source. Build cues from text segments, apply redaction, and prefix known voices with `[Name]:`; unknown German-prefixed labels are omitted. Wrap around 42 characters per line, two lines per cue; allocate times by text length, insert 0.5-second gaps, target at most seven seconds, and a minimum of one second or character count/17. Acceptance: valid SRT has numbered cues and comma milliseconds; VTT starts `WEBVTT` with dot milliseconds. Preserve the fixture output in section 3 for deterministic regression. Very long words/minimum duration can override target limits or overrun the original segment; do not promise strict cue-to-word timing. Source: Utils `getSubtitleBlocks`, Export.
- [ ] **T-47. Raw JSON.** Live. Export is the segment array, not a full job/record object; retain timing, speaker, text, decoder fields and redaction metadata. Acceptance: parsed export equals current segments, including original redacted text; no preset/anonymization filter changes JSON. Source: Export `exportToJSON`.
- [ ] **T-48. Summary empty/loading/result/error.** Live generated summary/source error. Summary opens with empty placeholder, generate action and selected template. Loading shows section skeletons and disables download; success renders Markdown and enables copy/export/regenerate. Acceptance: a real transcript yields readable sections, a failed request exposes error and retry, and no cached result is displayed for the wrong transcript/template. Source: Export `renderErgebnisprotokoll`, screenshots 10–12. Output (verified against kiChat 2026-10-07): the summary Markdown holds only the AI sections, each `## heading` followed on the next line by its content; the template's headings, text and dividers appear only in the editor preview, and Campus assembles summaries the same way. Campus deviation: when a saved transcript opens, Campus looks up a summary stored for the same revision, title, template version and model (`checkOnly`) and shows it as ready; kiChat starts every opened transcript at "Noch keine Zusammenfassung" and its placeholder button forces a new run. Campus keeps the lookup because it saves a second chat-model run and its cache is keyed by revision, template and model (recommended by the comparison; needs PO confirmation).
- [ ] **T-49. Summary generation and caching.** Live normal generate and section preview/source cache paths. Requests use transcript slug, selected template and optional model; force regeneration is distinct from cached retrieval. A `check_only` request can ask for existing summary. If no saved slug exists, source can send transcript text, applying redaction. Acceptance: generate and regenerate use correct flags and identifiers; changing template invalidates inappropriate preview; don't assume that a saved-slug summary excludes redacted text because the server's assembly was not inspected. Source: Export `generateErgebnisprotokoll`, `exportToErgebnis`. Redaction (verified with the probe 2026-10-07): kiChat's saved-slug summary and section preview read the unredacted text; with `Unterlagen` redacted, both still named it. Campus deliberately deviates for privacy and summarises the redacted text (see Q-10).
- [ ] **T-50. Summary template chooser.** Live. My templates and built-in library, search by name/subtext, use action, create action, edit custom, customize/copy built-in and delete custom. Acceptance: choosing a template changes the active name/subtext; built-in copies get a copy name and a new ID; built-ins do not show the custom-delete action. Exact five built-in structures are captured below. Source: Export template selection/list methods; screenshot 14.
- [ ] **T-51. Template structure editor.** Live controls/source. Name and ordered blocks: H1/H2/H3 headings, static text, divider, AI section with heading and instruction. Add, move up/down, drag-reorder and delete blocks. AI section shortcuts include summary, tasks, decisions, results, key points, quotes, themes and free instruction. Acceptance: save transmits ordered structure, reload/edit preserves it, and blank-name validation blocks save. `POST` can create a second same-name template with a disambiguated server ID; do not assume unique names. Source: Export editor methods; screenshot 15.
- [ ] **T-52. Template placeholders.** Live controls/source. Insert title, date, participants and duration tokens at the last-focused field cursor or append when none is focused. Acceptance: placeholders substitute in editor preview and do not remain literal in generated output. Token vocabulary is `{{title}}`, `{{date}}`, `{{participants}}`, `{{duration}}`, with German aliases supported by source. Reference preview fallback participants are "Sten, Soria, Nadia" and duration is 45 minutes when no state duration is set; these are preview sample values, not transcript facts. Source: Export `insertPlaceholder`, `getPlaceholderValues`.
- [ ] **T-53. Test and refresh AI section previews.** Live two-section request/source. Preview combines static blocks and generated sections. Test preview submits stale headings; per-section refresh regenerates that section. Cache keys include heading/instruction hash and live in localStorage. Acceptance: changed instruction marks cached result stale, generation shows section loading/error, and a successful response fills only requested sections. Source: Export preview methods. The exact deployed cache key is `hawki_template_preview_cache`.
- [ ] **T-54. Summary template persistence/deletion.** Live create/delete. User templates have stable ID, name, structure, version and ownership distinct from built-ins. Delete asks confirmation. Acceptance: custom template is present after reload, cancellation retains it, successful DELETE removes it and returns a valid active selection. Do not expose another user's templates. Source: Export, API responses.

### Microphone and live transcription

- [ ] **T-55. Microphone permissions and devices.** Live permission denial/source. Ask browser permission, enumerate input devices, support default device and labeled microphone choices, use fallback labels where permission hides device labels, react to disappearing devices. Acceptance: denial produces catalog error and returns to recoverable idle state; selectors are locked while requesting/recording/stopping. Selected device is shared by regular/live recording. Source: Recording; screenshot 27.
- [ ] **T-56. Regular recording lifecycle.** Source/visible controls, no successful capture. States are idle, requesting, recording, stopping, ready and error; start/stop control, running status and elapsed time. Acceptance: successful start acquires chosen audio stream and MediaRecorder, stop waits for final chunks and releases resources; no pause control is required because none was observed. No maximum recording duration was found. Source: Recording `startLiveRecording`, `stopLiveRecording`.
- [ ] **T-57. Recording list and WAV conversion.** Source. Both regular and live modes capture local audio chunks. Decode the actual browser recording format and re-encode valid PCM16 WAV with the buffer's sample rate/channel count; never label WebM bytes WAV. Filename `<username>-YYYYMMDD-HHMMSS.wav`. Multiple takes remain in memory with waveform/playback/duration, download and two-step delete/cancel. Acceptance: WAV has RIFF header and is playable/uploadable, deletes affect only the selected take, and leaving/reloading does not imply persistent storage of local recordings. Successful take lifecycle needs an actual microphone test.
- [ ] **T-58. Upload recorded takes.** Source/visible action. Upload all retained recordings into one normal file group, clear local recording list and run the standard automatic analysis flow. Acceptance: stopping alone does not upload; upload uses the same file validation, grouping, mapping and dispatch as external files. Source: Recording `uploadLiveRecording`.
- [ ] **T-59. Live provider selection.** Live config/source. Two modes `onprem` and `openai`; observed default `onprem`. Acceptance: show available modes, select before connection, lock during active lifecycle, obtain credentials only through server endpoints. Batch provider settings are distinct from live mode. Source: Recording, Realtime; screenshot 18.
- [ ] **T-60. Live connection and transcript lifecycle.** Source only after microphone denial. WebRTC audio stream plus `oai-events` data channel; wait for connection before recording, accumulate text from delta/completed events, avoid duplicated completed text, auto-scroll, and report signaling/connection/service errors. Acceptance: stop commits on-prem audio, waits for pending items up to 20 seconds, then tears down tracks/channel/peer; repeated stops join one promise. A delta followed by identical completion must appear once. Source: Realtime; API in section 3. Successful on-prem/OpenAI session is unresolved.
- [ ] **T-61. Live appearance controls.** Live controls/source. Font size slider 32–100 px, default 32; contrast inversion and maximize/restore with pressed state; demonstration/empty text until live content. Acceptance: controls change presentation without altering transcript, maximize restores, and new-session/reset clears accumulated text. Source: Recording appearance methods; screenshot 18/20.
- [ ] **T-62. Narrow layout and panel behavior.** Live instrumented 390 × 844 probes/source. Left icon rail and expanded 320-pixel transcript sidebar consume almost all width; upload/live/result work area is obscured. Sidebar toggle and result tools toggle exist. Instrumented global module state and width-transition behavior prevent concluding that normal mobile collapse is broken or works correctly. Acceptance: reference reviewers must repeat these modes on a normally unlocked narrow browser. Campus proposal must expose all functions at narrow widths with its supported settings layout, including touch selection, rather than treating an inaccessible screenshot as a target layout. Evidence: screenshots 20/29/31/32; section 7.
- [ ] **T-63. Provider/model settings path.** Authenticated config GET/source, dialog unresolved. Configuration service exposes current provider/model and POST `{provider,model}`; frontend settings functions and select definitions exist, but their modal element was absent in this rendered page. Acceptance: do not claim a visible user model switch was tested. If reference owners confirm it is intended, implement provider/model selection with allowed options and save/error feedback. Current batch backend is fixed by the observed config to Custom Speaches and `jlu/whisper-1`, independent of the live modes. Source: Service; section 7.

Transcript preset truth table, `1` means enabled:

| ID | Reference label DE | Names | Timestamps | Avatars | Bubbles | Anonymize | Order |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dialog_standard` | Dialog (Standard) | 1 | 1 | 1 | 1 | 0 | chronological |
| `lesefassung` | Lesefassung | 1 | 0 | 0 | 0 | 0 | chronological |
| `zeitcodes` | Mit Zeitcodes | 0 | 1 | 0 | 0 | 0 | chronological |
| `sprecher_gruppiert` | Nach Sprecher gruppiert | 1 | 0 | 0 | 0 | 0 | speaker |
| `fliesstext` | Nur Fließtext | 0 | 0 | 0 | 0 | 0 | chronological |

## 3) Observed API/backend behaviour

### Transport and engine findings

Authenticated reference APIs are same-origin `/req/*`. Mutation calls send the page's CSRF meta token as `X-CSRF-TOKEN`, generally JSON content type and sometimes `Accept: application/json`/`X-Requested-With: XMLHttpRequest`. Never embed kiChat credentials or endpoints requiring its cookie in Campus. Batch upload uses signed S3-compatible storage PUT through XMLHttpRequest for upload progress. Storage URLs are short-lived and bearer-equivalent; their signatures are deliberately omitted here.

`GET /req/transcription-config` returned current provider `{name:"Custom Speaches",unique_name:"custom_speaches",base_url:"https://api.hrz.uni-giessen.de/v1",source:"app_settings",id:null,is_active:true}` and current model `{id:null,label:"jlu/whisper-1",model_id:"jlu/whisper-1",source:"app_settings",is_active:true}`. The response also exposed an API-key field in provider configuration. Its value is excluded from all requirements; Campus must keep secrets on the server. The listed selectable provider included OpenAI chat-model options, inconsistent with the actual current speech provider; a reachable user switch was not verified.

Inference: the batch engine is a Whisper-style OpenAI-compatible Speaches service, supported by provider name, `/v1` URL, model name and Whisper segment fields. A separate diarization server is directly evidenced by its error. The browser does not call `/v1/audio/transcriptions` itself; a backend queue, normalization, chunk extraction, diarization and correction pipeline mediates work. Neither exact Whisper implementation nor pyannote/WhisperX, GPU setup, queue technology, diarization model, or LLM correction/summary model can be proven from these frontend observations. Laravel is evidenced by error responses naming its exception/model classes. Do not make Laravel, MinIO, a specific queue, or a specific diarization engine a Campus requirement.

Batch polling uses two-second status fetches in normal analysis/processing and restored analysis; restored transcription polling uses a three-second interval. The initial upload maps XHR percentage to 2–50%; analysis may creep from 50 to 98% and resets on queue wait. Only after a successful PUT response does analysis begin. Client code has no finite batch timeout. No batch SSE or job WebSocket was observed. Realtime instead uses WebRTC; on-prem source comments describe a server bridge to a vLLM/Voxtral WebSocket upstream. That engine description is source evidence, not a successful backend session observation.

### Endpoint contract

The following paths are reference contracts, not proposed Campus routes. `J` means JSON body, `B` binary body. Status codes are observed where stated; source-only rows do not assert a successful response was seen.

| Method/path | Request | Response and evidence |
| --- | --- | --- |
| GET `/req/transcription-config` | None | 200 `{success:true,data:{current:{provider,model},providers:[…]}}`, Live |
| POST `/req/transcription-config` | J `{provider,model}` | `{success,message}`, Source, not mutated |
| POST `/req/transcription/async/session` | J `{filename,language,speaker_count}` | 200 `{success:true,session:{job_id,s3_path,upload_url}}`, Live |
| PUT signed `upload_url` | B source bytes, file MIME or `application/octet-stream` | 200 empty body, Live; storage signature expires in 3,600 seconds |
| POST `/req/transcription/async/analyze/:jobId?duration=<seconds>` | No JSON body | 200 `{success:true,message:"Analyze job dispatched successfully",status:"analyzing_speakers_queued"}`, Live |
| GET `/req/transcription/async/status/:jobId` | None | 200 `{success:true,status,job_id,manifest:null\|object,error:null\|string,result?:object}`, Live |
| POST `/req/transcription/async/dispatch/:jobId` | J `{speaker_mapping,speaker_snippets,speaker_count,llm_correction}` | 200 `{success:true,message:"Job dispatched successfully",status:"preprocessing"}`, Live |
| DELETE `/req/transcription/async/job/:jobId` | None | Source expects `{success}`. Research deletes succeeded in effect; repeating after deletion returned Laravel missing-model error/500. Physical bytes not inspected |
| GET `/req/transcriptions/jobs/active` | None | 200 `{success:true,jobs:[]}`, Live. Source expects each job `{id,filename,status,…}` |
| GET `/req/transcription/audio?job_id=:jobId` | None | 200 `{success:true,url:<signed URL>}`, Live, URL expiry 7,200 seconds |
| POST `/req/transcription/save` | J saved-record input below | 201 `{success:true,transcription:{record metadata},message:"Transkription erfolgreich gespeichert"}`, Live |
| GET `/req/transcriptions` | None | 200 `{success:true,transcriptions:[{id,slug,title,subtitle,language,duration,original_filename,created_at,updated_at}]}`, Live |
| GET `/req/transcription/:slug` | None | 200 `{success:true,transcription:{full record}}`, Live; 404 `{success:false,error:"Transkription nicht gefunden"}` after deletion |
| PATCH `/req/transcription/:slug/title` | J `{title}` | 200 `{success:true,message:"Titel erfolgreich aktualisiert"}`, Live |
| PATCH `/req/transcription/:slug/subtitle` | J `{subtitle}` | 200 `{success:true,subtitle,message:"Unterzeile erfolgreich aktualisiert"}`, Live |
| PATCH `/req/transcription/:slug/segments` | J `{segments,speaker_color_map}` | 200 `{success:true,message:"Segmente erfolgreich aktualisiert"}`, Live |
| DELETE `/req/transcription/:slug` | None | Live UI confirmed; subsequent list empty/detail 404. Source does not validate response before removing row |
| POST `/req/transcription/optimize-speakers` | J `{segments}` | `{success:true,segments}` or `{success:false,error}`, Source |
| POST `/req/transcription/summarize` | J summary variants below | `{success:true,summary:<Markdown>}`; preview 200 `{success:true,results:{<heading>:<Markdown>}}`, Live |
| GET `/req/transcription/templates` | None | 200 `{success:true,templates:[template]}`, Live |
| POST `/req/transcription/templates` | J `{id:null\|string,name,structure}` | 200 `{success:true,template}`, Live |
| DELETE `/req/transcription/templates/:id` | None | Live removal; repeat 500 `{success:false,error:"Fehler beim Löschen der Vorlage: No query results for model [App\\Models\\Transcription\\SummaryTemplate]."}` |
| GET `/req/transcription/formats` | None | 200 `{success:true,formats:[format]}`, Live |
| POST `/req/transcription/formats` | J `{id:null\|number,name,speakers,timestamps,avatars,bubbles,anonymize,order}` | 200 `{success:true,format}`, Live |
| DELETE `/req/transcription/formats/:id` | None | Live removal; repeat 500 `{success:false,error:"Fehler beim Löschen des Formats: No query results for model [App\\Models\\Transcription\\CustomTranscriptFormat]."}` |
| GET `/req/transcription/realtime/config` | None | 200 `{provider:"onprem",available_modes:["onprem","openai"]}`, Live |
| POST `/req/transcription/realtime/onprem/signaling` | J `{sdp:<offer>}` | `{sdp:<answer>}` or `{error}`, Source |
| POST `/req/transcription/realtime/session` | CSRF header | `{value:<ephemeral API key>}`, Source |
| POST `https://api.openai.com/v1/realtime/calls` | SDP text, `application/sdp`, Bearer ephemeral key | SDP answer text, Source; never use a long-lived key in browser |
| POST `/req/changeLanguage` | J `{inputLang:"de_DE"\|"en_US"}` | 200 `{success:true}`, Live; global app concern |

A missing job on repeated deletion produced a framework JSON exception with stack data. Preserve the existence of an error state, not that stack disclosure or the reference's 500-for-missing-resource behavior, in Campus.

### Batch job state and payload details

Observed lifecycle:

```text
session + signed PUT
  -> analyzing_speakers_queued
  -> analyzed_speakers
  -> dispatch -> preprocessing
  -> preprocessed
  -> transcribing, progress.phase = diarizing
  -> optimizing, progress.phase = optimizing
  -> completed -> saved history transcript
```

`analyzing_speakers` is source-supported but the short fixture did not expose it between polls. `failed` is live-tested with invalid audio. Dispatch/save are distinct operations. A completed job can exist before its transcript is saved, and active-job recovery addresses this. Do not equate job completion with durable history insertion.

Analyzed manifest shape, values shortened without signed credentials:

```json
{
  "settings": {"duration": 11.240544, "filename": "campus-test.wav", "language": "auto", "speaker_count": "auto"},
  "speakers": [{
    "id": "SPEAKER_00", "label": "Stimme 1", "start": 0.03096875, "end": 5.03096875,
    "samples": [{"start": 0.03096875, "end": 5.03096875}],
    "audio_url": "<signed source URL for sample playback>"
  }],
  "speaker_count": 1
}
```

Automatic labels are locale-normalized by the frontend; do not rely on the server label's language. The dispatch sent:

```json
{
  "speaker_mapping": {"SPEAKER_00": "Test speaker"},
  "speaker_snippets": [{"id": "SPEAKER_00", "name": "Test speaker", "start": 0.03096875, "end": 5.03096875}],
  "speaker_count": "auto",
  "llm_correction": 1
}
```

Preprocessed manifest exposes `job_id`, `source`, `normalized`, `chunks`, `settings` and `extracted_snippets`. Observed source was WAV, 22,050 Hz mono, 352,831-bit/s reported bitrate. Normalization used `pcm_s16le`, 16,000 Hz mono. A single chunk had `{index:0,path:"s3://audio-ingest-staging/jobs/<id>/chunks/chunk_000.wav",start:0,end:11.24,duration:11.24,overlap_start:0,overlap_end:0}`. `extracted_snippets` includes base64 WAV data. This confirms normalization/chunking, but not long-file chunk size or overlap policy. Progress for the short run reported `{current_chunk:0,total_chunks:0,phase:"diarizing"}` and later phase `optimizing`.

Completed result has `{success,text,language,segments,words}`. The original successful fixture returned:

```json
{
  "success": true,
  "text": "Guten Tag. Dies ist ein kurzer Test der Transkription für die Universität Gießen. Wir treffen uns am Montag um 10 Uhr. Vielen Dank.",
  "language": "de",
  "segments": [{
    "id": 1, "start": 0, "end": 10.72, "speaker": "Test speaker",
    "text": "Guten Tag. Dies ist ein kurzer Test der Transkription für die Universität Gießen. Wir treffen uns am Montag um 10 Uhr. Vielen Dank.",
    "avg_logprob": -0.0568241, "compression_ratio": 0.98837, "temperature": 0, "seek": 0,
    "no_speech_prob": null, "tokens": "<integer array>"
  }],
  "words": []
}
```

`tokens` above is a shape annotation, not an actual string field. The captured raw response contains the array. Do not require identical transcription text from a different engine; require correct language, plausible timing, speaker assignment, editable text and preservation of returned fields.

Save input contains `segments`, `words`, `language`, `duration`, `model_used`, `provider`, `original_filename`, `file_size`, `title`, and `metadata` with client timestamp/source files. Client may send null model/provider and backend supplies the configured values. Source-file metadata has `{name,size,duration,start_time,end_time,job_id}`. Full detail also includes `id`, `slug`, `user_id`, `user_locale`, `created_at`, `updated_at`, `transcript_text`, `subtitle` and `summary_template_id`. Metadata can contain `subtitle_source: "ai"`, `speaker_color_map` keyed by speaker name, and each color value `{colorId,speakerIndex}`. Segment redactions are offset arrays; decoder/word fields must survive edits unless explicitly transformed.

The invalid WAV returned HTTP 200 status response with terminal `failed`, null manifest, and exact error:

```text
Fehler bei der Sprecher-Analyse: Sprecheranalyse fehlgeschlagen (Diarization-Server antwortete mit Status 415).
```

Its queue row displayed failure; the raw detail was available in the response/console. This error stayed German while the UI locale was English.

### Summaries, templates, formats, and local state

Normal summary generation sends `{transcription_slug,force_regenerate:false,template_id}`; regenerate sends true. Optional `model` is source-supported but the corresponding result model selector was not reachable. Unsaved/local input can use `{transcript_text}`. Existing-result lookup uses `{transcription_slug,check_only:true}`. AI editor previews send `{transcription_slug,sections:[<section blocks>],stale_headings:[<headings>],preview:true,model?:…}`. Live preview returned a heading-keyed `results` object. Final summaries are Markdown, not a job/polling API. Frontend summary generation is one awaited fetch with loading placeholders; backend async implementation is unknown.

Template records contain `{id,user_id,name,description,is_builtin,sections,structure,version,output_format_hints,created_at,updated_at}`. Blocks are `{type:"heading",level:1|2|3,text}`, `{type:"text",text}`, `{type:"divider"}`, or `{type:"section",heading,instruction}`. Both `sections` and `structure` appeared in returned built-ins with the same ordered blocks. Custom save requires only id/name/structure. Same-name creation produced two different IDs.

Format records contain `id`, owner information, name, boolean `speakers/timestamps/avatars/bubbles/anonymize`, `order:"chronological"|"speaker"`, and created/updated timestamps. Source migrates old localStorage formats to server persistence. Preview cache uses `hawki_template_preview_cache`, nested by transcript slug, template name and section heading, with an instruction hash. Legacy format storage uses `customTranscriptTemplates`; successful migration removes that key. Reference browser-only preferences must not become server secrets.

The original SRT and VTT differed only in header/timestamp convention:

```srt
1
00:00:00,000 --> 00:00:05,657
[Test speaker]: Guten Tag. Dies ist ein
kurzer Test der Transkription für die

2
00:00:06,157 --> 00:00:10,720
Universität Gießen. Wir treffen uns am
Montag um 10 Uhr. Vielen Dank.
```

```vtt
WEBVTT

1
00:00:00.000 --> 00:00:05.657
[Test speaker]: Guten Tag. Dies ist ein
kurzer Test der Transkription für die

2
00:00:06.157 --> 00:00:10.720
Universität Gießen. Wir treffen uns am
Montag um 10 Uhr. Vielen Dank.
```

### Realtime protocol

Source creates `RTCPeerConnection`, obtains selected microphone media, creates `oai-events`, and sends an SDP offer. On-prem uses ICE/TURN metadata from the page; OpenAI has a separate connection path. ICE gathering has a five-second safety timeout and connection waiting a 15-second timeout. OpenAI obtains a server-issued ephemeral key, sends offer SDP directly to its realtime calls endpoint, and on data-channel open sends `session.update` with `{type:"transcription",audio:{input:{transcription:{model:"gpt-realtime-whisper"}}}}`.

Source recognizes committed item IDs, `conversation.item.input_audio_transcription.delta`, `.completed`, `.failed`, generic errors, and `conversation.item.done` fallback transcript content. Deltas append immediately; completed messages append only an undelivered suffix. Pending item IDs track finalization. On-prem stop sends `input_audio_buffer.commit`, waits for completion/failure/pending drainage up to 20 seconds, then closes resources. Local audio recording shares the acquired stream so a stopped live session can also yield a WAV take. No actual media connection succeeded because browser microphone permission was denied; signaling response payloads and live accuracy remain source-only.

### Exact built-in summary structures

These are the five returned built-ins. They are German template content even in an English UI; an English translation of their names/instructions was not returned. Seed equivalent structures for parity; adding English template content is a proposal requiring approval. Description and ordered structure below are verbatim, without account/timestamp metadata.

```json
{
  "id": "focus-group",
  "name": "Fokusgruppe",
  "description": "Analyse von Gruppendiskussionen und Moderationsrunden.",
  "structure": [
    {
      "level": 1,
      "text": "Fokusgruppe: {{title}}",
      "type": "heading"
    },
    {
      "text": "Datum: {{date}} · Teilnehmer: {{participants}}",
      "type": "text"
    },
    {
      "heading": "Diskussion",
      "instruction": "Fasse den Verlauf der Diskussion und die verschiedenen Meinungen zusammen.",
      "type": "section"
    },
    {
      "heading": "Moderation",
      "instruction": "Analysiere die Rolle der Moderation und den Leitfaden.",
      "type": "section"
    },
    {
      "heading": "Kernthemen",
      "instruction": "Identifiziere die zentralen Themen und Erkenntnisse aus der Gruppenbefragung.",
      "type": "section"
    }
  ],
  "version": 1,
  "output_format_hints": null
}
```

```json
{
  "id": "interview",
  "name": "Interview",
  "description": "Auswertung von Einzelinterviews mit Fokus auf Zitate und Themen.",
  "structure": [
    {
      "level": 1,
      "text": "Interview: {{title}}",
      "type": "heading"
    },
    {
      "text": "Datum: {{date}} · Teilnehmer: {{participants}}",
      "type": "text"
    },
    {
      "heading": "Kernaussagen",
      "instruction": "Fasse die Hauptthemen und wichtigsten Kernaussagen des Interviews zusammen.",
      "type": "section"
    },
    {
      "heading": "Zitate",
      "instruction": "Extrahiere besonders prägnante und repräsentative Zitate aus dem Gespräch.",
      "type": "section"
    },
    {
      "heading": "Themen",
      "instruction": "Gliedere das Gespräch in die behandelten Themenschwerpunkte.",
      "type": "section"
    }
  ],
  "version": 1,
  "output_format_hints": null
}
```

```json
{
  "id": "meeting-protocol",
  "name": "Meeting-Protokoll",
  "description": "Strukturiertes Protokoll für Meetings und Teambesprechungen.",
  "structure": [
    {
      "level": 1,
      "text": "Meeting-Protokoll: {{title}}",
      "type": "heading"
    },
    {
      "text": "Datum: {{date}} · Dauer: {{duration}}",
      "type": "text"
    },
    {
      "text": "Teilnehmer: {{participants}}",
      "type": "text"
    },
    {
      "heading": "Ergebnisse",
      "instruction": "Fasse die wichtigsten Ergebnisse des Meetings zusammen.",
      "type": "section"
    },
    {
      "heading": "Beschlüsse",
      "instruction": "Liste alle getroffenen Beschlüsse und Vereinbarungen als Stichpunkte.",
      "type": "section"
    },
    {
      "heading": "To-dos",
      "instruction": "Erstelle eine To-do-Liste mit Aufgaben, Zuständigkeiten und Fristen.",
      "type": "section"
    }
  ],
  "version": 1,
  "output_format_hints": null
}
```

```json
{
  "id": "mein-interview-format",
  "name": "Mein Interview-Format",
  "description": "Benutzerdefiniertes Format für strukturierte Interviews.",
  "structure": [
    {
      "level": 1,
      "text": "{{title}}",
      "type": "heading"
    },
    {
      "text": "Datum: {{date}} · {{participants}}",
      "type": "text"
    },
    {
      "heading": "Zusammenfassung",
      "instruction": "Fasse das Gespräch in 3–4 Sätzen zusammen.",
      "type": "section"
    },
    {
      "heading": "Wichtigste Entscheidungen",
      "instruction": "Liste alle Entscheidungen als Stichpunkte.",
      "type": "section"
    },
    {
      "heading": "Offene Aufgaben",
      "instruction": "Extrahiere To-dos mit verantwortlicher Person.",
      "type": "section"
    }
  ],
  "version": 1,
  "output_format_hints": null
}
```

```json
{
  "id": "legacy",
  "name": "Standard-Protokoll",
  "description": "Das standardmäßige HAWKI-Ergebnisprotokoll.",
  "structure": [
    {
      "heading": "",
      "instruction": "Du bist ein Experte für Gesprächsprotokolle. Hier ist das Transkript eines Gesprächs. Erstelle ein professionelles Ergebnisprotokoll.\n\nStruktur:\n1. Titel/Thema (basierend auf dem Inhalt)\n2. Zusammenfassung (kurz und prägnant)\n3. Wichtigste Kernaussagen (als Stichpunkte)\n4. Beschlüsse und nächste Schritte (falls identifizierbar)\n\nSprache: Deutsch. Form: Professionell, sachlich.",
      "type": "section"
    }
  ],
  "version": 1,
  "output_format_hints": null
}
```

## 4) UI texts de/en

The table appended in this section is the complete deployed `Transcript*` translation namespace, 354 keys in each locale, as returned by the authenticated German and English pages. Strings are verbatim; JSON quoting represents line breaks/quotes, and Markdown escaping protects table delimiters. It includes latent/source-only/error states as well as visited states. A key's presence does not prove that its control is reachable. Preserve placeholders such as `{count}`, `{id}` and literal HTML according to their intended rendering, rather than translating away their syntax.

Other reference-visible text not fully covered by that namespace:

| Context | German | English / observation |
| --- | --- | --- |
| Actual failed analysis response | "Fehler bei der Sprecher-Analyse: Sprecheranalyse fehlgeschlagen (Diarization-Server antwortete mit Status 415)." | Same German backend error in English UI |
| Missing transcript response | "Transkription nicht gefunden" | Same server string observed |
| Player button hardcoded accessible title | "Abspielen / Pause" | Same German source string in English view |
| Inserted/empty speaker placeholder | "[Dieser Sprecher hat noch keinen Text!]" | Same hardcoded source string |
| Redacted text export marker | "[AUSGEBLENDET]" | Same hardcoded source marker |
| AI section refresh network failure, hardcoded | "Verbindungsfehler beim Generieren." | Same German source string; other generation errors use the catalog |
| Realtime connection failure, source-only | "Audio connection failed." / "Audio connection closed." | Same English source strings in either locale |
| Realtime connection timeout, source-only | "Audio connection not established within 15s." | Same English source string in either locale |
| Realtime session/signaling fallback, source-only | "Failed to create realtime session." / "Realtime bridge error." | Same English source strings in either locale |
| OpenAI response error prefix, source-only | "OpenAI Realtime API Error: " + provider response | Same English source prefix in either locale |
| Initial group naming | "Transcript 1", "Transcript 2" | Same source naming |
| Generic modal | Shared global warning/error/info headings and confirm/cancel controls | English deletion dialog showed "Warning!", "Decline", "Confirm" |
| Browser microphone denial detail | Browser-specific permission error | "Microphone permission denied: Permission denied" in this browser |

Campus should put these fixed labels into its own de/en i18n files. Correcting hardcoded German accessibility labels in English is a proposed localization improvement. Backend diagnostics should be available without leaking raw credentials/framework stacks; user-facing equivalents use i18n error codes. Keep catalog strings in this section as reference evidence even if an approved Campus copy change is made.

| Translation key | German, verbatim | English, verbatim |
| --- | --- | --- |
| `TranscriptAccuracyWarning` | "Transkription kann Fehler enthalten. Überprüfe wichtige Informationen." | "Transcriptions can contain errors. Please check important information." |
| `TranscriptAddFileFirst` | "Bitte füge zuerst mindestens eine Datei hinzu." | "Please add at least one file first." |
| `TranscriptAddSnippet` | "Snippet hinzufügen" | "Add snippet" |
| `TranscriptAddSpeaker` | "Stimme hinzufügen" | "Add voice" |
| `TranscriptAddTranscript` | "Neues Transcript hinzufügen" | "Add new transcript" |
| `TranscriptAdjustSpeakers` | "Sprecher anpassen" | "Adjust speakers" |
| `TranscriptAdvancedSettings` | "Erweiterte Einstellungen" | "Advanced settings" |
| `TranscriptAiTranscriptLabel` | "KI-TRANSKRIPT" | "AI TRANSCRIPT" |
| `TranscriptAnalysisError` | "Fehler bei der Analyse: " | "Analysis error: " |
| `TranscriptAnalysisFailed` | "Analyse fehlgeschlagen." | "Analysis failed." |
| `TranscriptAnalysisJobStartFailed` | "Konnte Analyse-Job nicht starten: " | "Could not start the analysis job: " |
| `TranscriptAnalyzingAudio` | "Analysiere Audio..." | "Analysing audio..." |
| `TranscriptAnalyzingSpeakers` | "Analysiere Sprecher..." | "Analysing speakers..." |
| `TranscriptAssignTo` | "Zuweisen an..." | "Assign to..." |
| `TranscriptAssignToColon` | "Zuweisen an:" | "Assign to:" |
| `TranscriptBack` | "Zurück" | "Back" |
| `TranscriptCancel` | "Abbrechen" | "Cancel" |
| `TranscriptChangeColor` | "Farbe ändern" | "Change color" |
| `TranscriptChoiceRecordDesc` | "Starten einer Sprachaufnahme, die direkt transkribiert wird." | "Start a voice recording that is transcribed right away." |
| `TranscriptChoiceRecordTitle` | "Audio aufnehmen" | "Record audio" |
| `TranscriptChoiceUploadDesc` | "Lade eine Audiodatei von deinem Computer hoch." | "Upload an audio file from your computer." |
| `TranscriptChoiceUploadTitle` | "Datei hochladen" | "Upload file" |
| `TranscriptClickToRename` | "Klicken zum Umbenennen" | "Click to rename" |
| `TranscriptClose` | "Schließen" | "Close" |
| `TranscriptConfirm` | "Bestätigen" | "Confirm" |
| `TranscriptConfirmDeleteEntry` | "Diesen Eintrag wirklich löschen?" | "Really delete this entry?" |
| `TranscriptConfirmDeleteGroup` | "Transcript mit {names} wirklich löschen? Laufende Transkriptions-Aufträge werden abgebrochen und die hochgeladenen Dateien entfernt." | "Really delete the transcript with {names}? Running transcription jobs will be cancelled and the uploaded files removed." |
| `TranscriptConfirmDeleteJob` | "\"{name}\" wirklich löschen? Der Transkriptions-Auftrag wird abgebrochen und die hochgeladene Datei entfernt." | "Really delete \"{name}\"? The transcription job will be cancelled and the uploaded file removed." |
| `TranscriptCopy` | "Kopieren" | "Copy" |
| `TranscriptCopySection` | "Abschnitt kopieren" | "Copy section" |
| `TranscriptCorrectionMode` | "Korrekturmodus" | "Correction mode" |
| `TranscriptCreatingSession` | "Session erstellen..." | "Creating session..." |
| `TranscriptDefaultMicrophone` | "Standardmikrofon" | "Default microphone" |
| `TranscriptDefaultTitle` | "Transkription vom {timestamp}" | "Transcription from {timestamp}" |
| `TranscriptDelete` | "Löschen" | "Delete" |
| `TranscriptDeleteGroupFailed` | "Mindestens ein Auftrag konnte nicht gelöscht werden. Bitte versuche es erneut." | "At least one job could not be deleted. Please try again." |
| `TranscriptDeleteJobFailed` | "Der Auftrag konnte nicht gelöscht werden. Bitte versuche es erneut." | "The job could not be deleted. Please try again." |
| `TranscriptDeleteJobTitle` | "Auftrag löschen" | "Delete job" |
| `TranscriptDeleteRecording` | "Aufnahme löschen" | "Delete recording" |
| `TranscriptDeleteSnippet` | "Snippet löschen" | "Delete snippet" |
| `TranscriptDeleteTranscriptGroup` | "Transcript löschen" | "Delete transcript" |
| `TranscriptDetectSpeakers` | "Sprecher*innen erkennen" | "Detect speakers" |
| `TranscriptDone` | "Fertig" | "Done" |
| `TranscriptDownload` | "Herunterladen" | "Download" |
| `TranscriptDownloadFile` | "Datei herunterladen" | "Download file" |
| `TranscriptDownloadRecording` | "Aufnahme herunterladen" | "Download recording" |
| `TranscriptDropZoneText` | "Dokumente hierher ziehen, oder" | "Drag files here, or" |
| `TranscriptEdit` | "Bearbeiten" | "Edit" |
| `TranscriptEditSubtitleHint` | "Klicken, um die Unterzeile zu bearbeiten" | "Click to edit the subtitle" |
| `TranscriptEditText` | "Text bearbeiten" | "Edit text" |
| `TranscriptEditTitleHint` | "Klicken, um den Titel zu bearbeiten" | "Click to edit the title" |
| `TranscriptEmptySpeakerHint` | "[Dieser Sprecher hat noch keinen Text!]" | "[This speaker has no text yet!]" |
| `TranscriptEnterNamePlaceholder` | "Name eingeben..." | "Enter a name..." |
| `TranscriptError` | "Fehler" | "Error" |
| `TranscriptExportActive` | "AKTIV" | "ACTIVE" |
| `TranscriptExportAdjustFormatting` | "Formatierung anpassen" | "Adjust formatting" |
| `TranscriptExportAiSectionGenerated` | "KI-Abschnitt (Generiert)" | "AI section (generated)" |
| `TranscriptExportAllSpeakersHidden` | "[Alle Sprecher ausgeblendet]" | "[All speakers hidden]" |
| `TranscriptExportAnonymised` | "Anonymisiert" | "Anonymized" |
| `TranscriptExportBlobFailed` | "Blob konnte nicht erstellt werden" | "The blob could not be created" |
| `TranscriptExportBubbles` | "Blasen" | "Bubbles" |
| `TranscriptExportBySpeakerShort` | "nach Sprecher" | "by speaker" |
| `TranscriptExportCategoryData` | "Daten" | "Data" |
| `TranscriptExportCategoryDocuments` | "Dokumente" | "Documents" |
| `TranscriptExportCategoryVideo` | "Video" | "Video" |
| `TranscriptExportChange` | "Ändern" | "Change" |
| `TranscriptExportCheckingData` | "Prüfe Daten..." | "Checking data..." |
| `TranscriptExportChooseTemplate` | "Vorlage wählen" | "Choose template" |
| `TranscriptExportChronological` | "chronologisch" | "chronological" |
| `TranscriptExportCommunicationError` | "Fehler bei der Kommunikation mit dem Server." | "Error communicating with the server." |
| `TranscriptExportConfirmDeleteTemplate` | "Möchtest du diese Vorlage wirklich löschen?" | "Do you really want to delete this template?" |
| `TranscriptExportConnectionError` | "Verbindungsfehler." | "Connection error." |
| `TranscriptExportCopied` | "Kopiert!" | "Copied!" |
| `TranscriptExportCreateSummary` | "Zusammenfassung erstellen" | "Create summary" |
| `TranscriptExportCreatedAt` | "Erstellt am: {timestamp}" | "Created on: {timestamp}" |
| `TranscriptExportCustom` | "Benutzerdefiniert" | "Custom" |
| `TranscriptExportCustomise` | "Anpassen" | "Customize" |
| `TranscriptExportDefaultTemplateName` | "Mein Interview-Format" | "My interview format" |
| `TranscriptExportDeleteFailed` | "Fehler beim Löschen: " | "Error while deleting: " |
| `TranscriptExportDivider` | "Trennlinie" | "Divider" |
| `TranscriptExportDocxFailed` | "Export fehlgeschlagen." | "Export failed." |
| `TranscriptExportDownloadAs` | "Herunterladen als" | "Download as" |
| `TranscriptExportDownloadAsDocx` | "Als DOCX herunterladen" | "Download as DOCX" |
| `TranscriptExportDownloadAsFormat` | "Als {format} herunterladen" | "Download as {format}" |
| `TranscriptExportDragToMove` | "Ziehen zum Verschieben" | "Drag to move" |
| `TranscriptExportEditTemplate` | "Vorlage bearbeiten" | "Edit template" |
| `TranscriptExportElementPalette` | "Element-Palette" | "Element palette" |
| `TranscriptExportEmptyStart` | "Leer beginnen" | "Start from scratch" |
| `TranscriptExportEnterTextPlaceholder` | "Text eingeben" | "Enter text" |
| `TranscriptExportFormatDeleteConnectionError` | "Verbindungsfehler beim Löschen." | "Connection error while deleting." |
| `TranscriptExportFormatSaveConnectionError` | "Verbindungsfehler beim Speichern." | "Connection error while saving." |
| `TranscriptExportFormatting` | "Formatierung" | "Formatting" |
| `TranscriptExportFullTranscript` | "Volltext-Transkript" | "Full transcript" |
| `TranscriptExportFullTranscriptDesc` | "Wort für Wort, mit Sprechern" | "Word for word, with speakers" |
| `TranscriptExportGenerateNow` | "Jetzt generieren" | "Generate now" |
| `TranscriptExportGenerateSummaryDesc` | "Erstelle eine KI-gestützte Zusammenfassung des aktuellen Transkripts. Dieser Vorgang dauert etwa 10-20 Sekunden." | "Create an AI-generated summary of the current transcript. This takes about 10-20 seconds." |
| `TranscriptExportGenerateSummaryTitle` | "Ergebnisprotokoll generieren" | "Generate summary report" |
| `TranscriptExportGeneratingReport` | "Ergebnisprotokoll wird generiert..." | "Generating summary report..." |
| `TranscriptExportGeneratingSummary` | "Zusammenfassung wird erstellt" | "Generating summary" |
| `TranscriptExportGeneratingSummaryHint` | "Je nach Länge des Transkripts dauert das einen Moment." | "Depending on the length of the transcript, this may take a moment." |
| `TranscriptExportGenerationFailed` | "Generierung fehlgeschlagen" | "Generation failed" |
| `TranscriptExportGenerationFailedPrefix` | "Generierung fehlgeschlagen: " | "Generation failed: " |
| `TranscriptExportHeading` | "Überschrift" | "Heading" |
| `TranscriptExportHeadingTextPlaceholder` | "Überschriftstext" | "Heading text" |
| `TranscriptExportHttpGenerationError` | "HTTP-Fehler beim Generieren" | "HTTP error while generating" |
| `TranscriptExportInsertDate` | "+ Datum" | "+ Date" |
| `TranscriptExportInsertDecisions` | "+ Entscheidungen" | "+ Decisions" |
| `TranscriptExportInsertDivider` | "+ Trennlinie" | "+ Divider" |
| `TranscriptExportInsertDuration` | "+ Dauer" | "+ Duration" |
| `TranscriptExportInsertFreeAi` | "+ Freier KI-Abschnitt" | "+ Free AI section" |
| `TranscriptExportInsertHeading` | "+ Überschrift" | "+ Heading" |
| `TranscriptExportInsertKeyPoints` | "+ Kernaussagen" | "+ Key points" |
| `TranscriptExportInsertParticipants` | "+ Teilnehmer" | "+ Participants" |
| `TranscriptExportInsertQuotes` | "+ Zitate" | "+ Quotes" |
| `TranscriptExportInsertResults` | "+ Ergebnisse" | "+ Results" |
| `TranscriptExportInsertSummary` | "+ Zusammenfassung" | "+ Summary" |
| `TranscriptExportInsertTextField` | "+ Textfeld" | "+ Text field" |
| `TranscriptExportInsertTitle` | "+ Titel" | "+ Title" |
| `TranscriptExportInsertTodos` | "+ To-Dos" | "+ To-dos" |
| `TranscriptExportInsertTopics` | "+ Themen" | "+ Topics" |
| `TranscriptExportInserted` | "Eingefügt" | "Inserted" |
| `TranscriptExportInstructionChanged` | "Anweisung geändert" | "Instruction changed" |
| `TranscriptExportInstructionPlaceholder` | "Anweisung für die KI (z.B. Fasse das Gespräch zusammen)" | "Instruction for the AI (e.g. summarize the conversation)" |
| `TranscriptExportLegendAi` | "die KI schreibt hier" | "the AI writes here" |
| `TranscriptExportLegendAuto` | "wird automatisch ausgefüllt" | "filled in automatically" |
| `TranscriptExportLibrary` | "Bibliothek" | "Library" |
| `TranscriptExportMinutesShort` | "{minutes} Min" | "{minutes} min" |
| `TranscriptExportMoveDown` | "Nach unten verschieben" | "Move down" |
| `TranscriptExportMoveUp` | "Nach oben verschieben" | "Move up" |
| `TranscriptExportMyTemplates` | "Meine Vorlagen" | "My templates" |
| `TranscriptExportNameRequired` | "Bitte gib einen Vorlagennamen ein." | "Please enter a template name." |
| `TranscriptExportNameRequiredShort` | "Bitte einen Vorlagennamen eingeben." | "Please enter a template name." |
| `TranscriptExportNameRequiredTitle` | "Eingabe erforderlich" | "Input required" |
| `TranscriptExportNames` | "Namen" | "Names" |
| `TranscriptExportNewHeading` | "Neue Überschrift" | "New heading" |
| `TranscriptExportNewTemplate` | "Neue Vorlage" | "New template" |
| `TranscriptExportNewTemplateName` | "Meine neue Vorlage" | "My new template" |
| `TranscriptExportNewText` | "Neuer Text" | "New text" |
| `TranscriptExportNoAiContentYet` | "Noch kein KI-Inhalt generiert. Klicke oben auf „Vorschau testen“." | "No AI content generated yet. Click “Test preview” above." |
| `TranscriptExportNoSpeakers` | "Keine Sprecher" | "No speakers" |
| `TranscriptExportNoSummaryYet` | "Noch keine Zusammenfassung" | "No summary yet" |
| `TranscriptExportNoTranscriptLoaded` | "Kein Transkript geladen." | "No transcript loaded." |
| `TranscriptExportOrder` | "Reihenfolge" | "Order" |
| `TranscriptExportOrderBySpeaker` | "Nach Sprecher" | "By speaker" |
| `TranscriptExportOrderChronological` | "Chronologisch" | "Chronological" |
| `TranscriptExportPaletteAi` | "KI-Elemente:" | "AI elements:" |
| `TranscriptExportPaletteData` | "Daten:" | "Data:" |
| `TranscriptExportPaletteStatic` | "Statische Elemente:" | "Static elements:" |
| `TranscriptExportParticipantsHeader` | "TEILNEHMER:" | "PARTICIPANTS:" |
| `TranscriptExportParticipantsPrefix` | "Teilnehmer: " | "Participants: " |
| `TranscriptExportPdfFailed` | "PDF Export fehlgeschlagen." | "PDF export failed." |
| `TranscriptExportPresetBySpeaker` | "Nach Sprecher gruppiert" | "Grouped by speaker" |
| `TranscriptExportPresetBySpeakerDesc` | "Aussagen je Person gebündelt" | "Statements bundled per person" |
| `TranscriptExportPresetDialog` | "Dialog (Standard)" | "Dialogue (default)" |
| `TranscriptExportPresetDialogDesc` | "Namen · Zeitstempel · Avatare · chronologisch" | "Names · timestamps · avatars · chronological" |
| `TranscriptExportPresetPlainText` | "Nur Fließtext" | "Plain prose only" |
| `TranscriptExportPresetPlainTextDesc` | "Ohne Namen & Zeitstempel" | "Without names & timestamps" |
| `TranscriptExportPresetReading` | "Lesefassung" | "Reading version" |
| `TranscriptExportPresetReadingDesc` | "Namen, ohne Zeitstempel — ruhig zum Lesen" | "Names, no timestamps — easy to read" |
| `TranscriptExportPresetTimecodes` | "Mit Zeitcodes" | "With timecodes" |
| `TranscriptExportPresetTimecodesDesc` | "Zeitstempel im Vordergrund — für Belege" | "Timestamps front and center — for citations" |
| `TranscriptExportPresets` | "Voreinstellungen" | "Presets" |
| `TranscriptExportPreviewConnectionError` | "Verbindungsfehler beim Generieren der Vorschau." | "Connection error while generating the preview." |
| `TranscriptExportPreviewReady` | "Vorschau bereit zum Herunterladen" | "Preview ready to download" |
| `TranscriptExportPreviewSubtitle` | "Überprüfe das Format vor dem Herunterladen." | "Check the format before downloading." |
| `TranscriptExportPreviewTitle` | "Export Vorschau" | "Export preview" |
| `TranscriptExportProtocolHeader` | "VERLAUFSPROTOKOLL" | "RUNNING RECORD" |
| `TranscriptExportQuestion` | "WAS MÖCHTEST DU EXPORTIEREN?" | "WHAT WOULD YOU LIKE TO EXPORT?" |
| `TranscriptExportRawData` | "Rohdaten (JSON)" | "Raw data (JSON)" |
| `TranscriptExportRawDataDesc` | "Für eigene Tools & KI" | "For your own tools & AI" |
| `TranscriptExportRefresh` | "Aktualisieren" | "Refresh" |
| `TranscriptExportRegenerateView` | "Ansicht neu generieren" | "Regenerate view" |
| `TranscriptExportResultLooksLike` | "So sieht das Ergebnis aus" | "This is what the result looks like" |
| `TranscriptExportSaveAsOwnTemplate` | "Als eigene Vorlage speichern" | "Save as your own template" |
| `TranscriptExportSaveFailed` | "Fehler beim Speichern: " | "Error while saving: " |
| `TranscriptExportSaveTemplate` | "Vorlage speichern" | "Save template" |
| `TranscriptExportSearchTemplate` | "Vorlage suchen" | "Search templates" |
| `TranscriptExportSection` | "Abschnitt" | "Section" |
| `TranscriptExportSectionNamePlaceholder` | "Abschnittsname (z.B. Zusammenfassung)" | "Section name (e.g. Summary)" |
| `TranscriptExportServerError` | "Unbekannter Serverfehler" | "Unknown server error" |
| `TranscriptExportShowSpeakers` | "Sprecher anzeigen" | "Show speakers" |
| `TranscriptExportSkeletonDecisions` | "Entscheidungen" | "Decisions" |
| `TranscriptExportSkeletonTasks` | "Aufgaben" | "Tasks" |
| `TranscriptExportSubtitles` | "Untertitel" | "Subtitles" |
| `TranscriptExportSubtitlesDesc` | "Für Video & Social" | "For video & social" |
| `TranscriptExportSummary` | "Zusammenfassung" | "Summary" |
| `TranscriptExportSummaryDesc` | "Kernaussagen & Ergebnisse" | "Key points & outcomes" |
| `TranscriptExportSummaryNotCreated` | "Zusammenfassung noch nicht erstellt" | "Summary not created yet" |
| `TranscriptExportSummaryReady` | "Zusammenfassung bereit zum Herunterladen" | "Summary ready to download" |
| `TranscriptExportSummarySkeleton` | "Zusammenfassung · Entscheidungen · Aufgaben" | "Summary · decisions · tasks" |
| `TranscriptExportTemplate` | "Vorlage" | "Template" |
| `TranscriptExportTemplateDeleteFailed` | "Fehler beim Löschen der Vorlage: " | "Error deleting the template: " |
| `TranscriptExportTemplateHint` | "Wird nach deiner Vorlage „{template}“ erstellt." | "Will be created from your “{template}” template." |
| `TranscriptExportTemplateNameInputPlaceholder` | "Vorlagenname eingeben..." | "Enter a template name..." |
| `TranscriptExportTemplateNamePlaceholder` | "Vorlagenname" | "Template name" |
| `TranscriptExportTemplateSaveFailed` | "Fehler beim Speichern der Vorlage: " | "Error saving the template: " |
| `TranscriptExportTestPreview` | "Vorschau testen" | "Test preview" |
| `TranscriptExportTestPreviewNotice` | "Test-Vorschau auf Basis eines Transkript-Ausschnitts. Der finale Export nutzt das komplette Gespräch und ist ausführlicher." | "Test preview based on an excerpt of the transcript. The final export uses the whole conversation and is more detailed." |
| `TranscriptExportTextSection` | "Textabschnitt" | "Text section" |
| `TranscriptExportToggleAnonymize` | "Sprecher anonymisieren" | "Anonymize speakers" |
| `TranscriptExportToggleAvatars` | "Avatare" | "Avatars" |
| `TranscriptExportToggleBubbles` | "Sprechblasen" | "Speech bubbles" |
| `TranscriptExportToggleSpeakerNames` | "Sprechernamen" | "Speaker names" |
| `TranscriptExportToggleTimestamps` | "Zeitstempel" | "Timestamps" |
| `TranscriptExportTranscriptId` | "Transkription-ID: {id}" | "Transcript ID: {id}" |
| `TranscriptExportUnknownSpeakerN` | "Unbekannt {n}" | "Unknown {n}" |
| `TranscriptExportUse` | "Verwenden" | "Use" |
| `TranscriptExportWhatWillBeCreated` | "Das wird erstellt" | "What will be created" |
| `TranscriptFailed` | "Fehlgeschlagen" | "Failed" |
| `TranscriptFileListTitle` | "Dateiliste" | "File list" |
| `TranscriptFileProcessingFailed` | "Datei konnte nicht verarbeitet werden." | "The file could not be processed." |
| `TranscriptFontSize` | "Schriftgröße" | "Font size" |
| `TranscriptGrantMicrophone` | "Mikrofon freigeben" | "Grant microphone access" |
| `TranscriptHide` | "Ausblenden" | "Hide" |
| `TranscriptHideSpeaker` | "Sprecher ausblenden" | "Hide speaker" |
| `TranscriptInProgress` | "Transkription läuft..." | "Transcription in progress..." |
| `TranscriptInsertSpeakerAfter` | "Sprecher danach einfügen" | "Insert speaker below" |
| `TranscriptInsertSpeakerAfterColon` | "Sprecher danach einfügen:" | "Insert speaker below:" |
| `TranscriptInsertSpeakerBefore` | "Sprecher davor einfügen" | "Insert speaker above" |
| `TranscriptInsertSpeakerBeforeColon` | "Sprecher davor einfügen:" | "Insert speaker above:" |
| `TranscriptInvertContrast` | "Kontrast umkehren" | "Invert contrast" |
| `TranscriptJobTitle` | "Transkription {id}" | "Transcription {id}" |
| `TranscriptLanguage` | "Sprache" | "Language" |
| `TranscriptLanguageEnglish` | "Englisch" | "English" |
| `TranscriptLanguageGerman` | "Deutsch" | "German" |
| `TranscriptLast7Days` | "Letzte 7 Tage" | "Last 7 days" |
| `TranscriptLivePreviewPlaceholder` | "Hier wird der Text stehen." | "Your text will appear here." |
| `TranscriptLivePreviewSample` | "Dies ist ein Beispieltext für die Live-Transkription." | "This is sample text for live transcription." |
| `TranscriptLoading` | "Wird geladen..." | "Loading..." |
| `TranscriptLoadingMicrophones` | "Mikrofone werden geladen..." | "Loading microphones..." |
| `TranscriptMaxFileSize` | "Maximal 500MB pro Datei." | "Maximum 500MB per file." |
| `TranscriptMaximizeTextView` | "Textansicht maximieren" | "Maximize text view" |
| `TranscriptMicrophone` | "Mikrofon" | "Microphone" |
| `TranscriptMicrophoneAccessUnsupported` | "Mikrofonzugriff nicht unterstützt" | "Microphone access not supported" |
| `TranscriptMicrophonePermission` | "Mikrofonfreigabe" | "Microphone permission" |
| `TranscriptMicrophonePermissionDenied` | "Mikrofonberechtigung verweigert: " | "Microphone permission denied: " |
| `TranscriptMicrophonePermissionHint` | "Bitte erlaube den Mikrofonzugriff in der Browser-Abfrage." | "Please allow microphone access in the browser prompt." |
| `TranscriptMicrophoneReady` | "Mikrofon bereit" | "Microphone ready" |
| `TranscriptMicrophonesUnavailable` | "Mikrofone nicht verfügbar" | "Microphones unavailable" |
| `TranscriptMinimizeTextView` | "Textansicht minimieren" | "Minimize text view" |
| `TranscriptModeLabel` | "Modus" | "Mode" |
| `TranscriptModeLocal` | "Lokal (Standard)" | "Local (default)" |
| `TranscriptModel` | "Modell" | "Model" |
| `TranscriptMoveDown` | "Nach unten schieben" | "Move down" |
| `TranscriptMoveFile` | "Datei verschieben" | "Move file" |
| `TranscriptMoveSentenceDown` | "Satz nach unten verschieben" | "Move sentence down" |
| `TranscriptMoveSentenceUp` | "Satz nach oben verschieben" | "Move sentence up" |
| `TranscriptMoveUp` | "Nach oben schieben" | "Move up" |
| `TranscriptMultipleSpeakers` | "Mehrere Personen" | "Multiple people" |
| `TranscriptNamePlaceholderShort` | "Name..." | "Name..." |
| `TranscriptNewSpeaker` | "Neuer Sprecher" | "New speaker" |
| `TranscriptNoProvidersAvailable` | "Keine Provider verfügbar" | "No providers available" |
| `TranscriptNoRedactions` | "Keine Ausblendungen vorhanden." | "No redactions yet." |
| `TranscriptNoServerResponse` | "Keine Antwort vom Server." | "No response from the server." |
| `TranscriptNoTranscriptLoaded` | "Keine Transkription geladen" | "No transcript loaded" |
| `TranscriptOlder` | "Vor längerer Zeit" | "Older" |
| `TranscriptOpenItem` | "{title} öffnen" | "Open {title}" |
| `TranscriptOptimizeSpeakersAI` | "Sprecher per KI optimieren" | "Optimize speakers with AI" |
| `TranscriptPreparing` | "Vorbereitung" | "Preparing" |
| `TranscriptPreprocessing` | "Vorverarbeitung" | "Pre-processing" |
| `TranscriptPreview` | "Vorschau" | "Preview" |
| `TranscriptProcessingJobStartFailed` | "Konnte Verarbeitungs-Job nicht starten." | "Could not start the processing job." |
| `TranscriptProvider` | "Provider" | "Provider" |
| `TranscriptReady` | "Bereit" | "Ready" |
| `TranscriptReadyForTranscription` | "Bereit für Transkription" | "Ready for transcription" |
| `TranscriptReadyFromCache` | "Bereit (aus Cache)" | "Ready (from cache)" |
| `TranscriptRecordingNotPossible` | "Aufnahme nicht möglich" | "Recording not possible" |
| `TranscriptRecordingProcessFailed` | "Die Aufnahme konnte nicht verarbeitet werden." | "The recording could not be processed." |
| `TranscriptRecordingReady` | "Aufnahme bereit" | "Ready to record" |
| `TranscriptRecordingRunning` | "Aufnahme läuft" | "Recording" |
| `TranscriptRecordingRunningHint` | "Das ausgewählte Mikrofon wird lokal im Browser aufgenommen." | "The selected microphone is being recorded locally in your browser." |
| `TranscriptRecordingStopping` | "Aufnahme wird beendet" | "Stopping recording" |
| `TranscriptRecordingStoppingHint` | "Die Audiodatei wird vorbereitet." | "The audio file is being prepared." |
| `TranscriptRecordingsReadyToUpload` | "{count} Aufnahmen bereit zum Hochladen" | "{count} recordings ready to upload" |
| `TranscriptRedactBracketed` | "[Ausblenden]" | "[Hide]" |
| `TranscriptRedactSelection` | "Text ausblenden (Schwärzen)" | "Hide text (redact)" |
| `TranscriptRedactionLabel` | "Schwärzung" | "Redaction" |
| `TranscriptRemoveFile` | "Datei entfernen" | "Remove file" |
| `TranscriptRemoveRedaction` | "Ausblendung entfernen" | "Remove redaction" |
| `TranscriptRemoveSpeaker` | "Sprecher entfernen" | "Remove speaker" |
| `TranscriptRemoveSpeakerAssignment` | "Sprecherzuweisung entfernen" | "Remove speaker assignment" |
| `TranscriptRenameSpeaker` | "Sprecher umbenennen" | "Rename speaker" |
| `TranscriptRepeatAnalysis` | "Analyse wiederholen" | "Repeat analysis" |
| `TranscriptRerunSpeakerAnalysis` | "Sprecheranalyse erneut ausführen" | "Run speaker analysis again" |
| `TranscriptRestartAnalysisFailed` | "Konnte Analyse nicht neu starten." | "Could not restart the analysis." |
| `TranscriptRetry` | "Erneut versuchen" | "Try again" |
| `TranscriptS3UploadFailed` | "Fehler beim Datei-Upload zu S3. Status: {status}" | "File upload to S3 failed. Status: {status}" |
| `TranscriptS3UploadNetworkError` | "Fehler beim Datei-Upload zu S3 (Netzwerkfehler)." | "File upload to S3 failed (network error)." |
| `TranscriptSampleN` | "Beispiel {n}" | "Sample {n}" |
| `TranscriptSave` | "Speichern" | "Save" |
| `TranscriptSaveChanges` | "Änderungen speichern" | "Save changes" |
| `TranscriptSaveFile` | "Datei speichern" | "Save file" |
| `TranscriptSaved` | "Gespeichert" | "Saved" |
| `TranscriptSavedExclaim` | "Gespeichert!" | "Saved!" |
| `TranscriptSaving` | "Speichern..." | "Saving..." |
| `TranscriptSearchPlaceholder` | "Suche Transkriptionen" | "Search transcriptions" |
| `TranscriptSearchPlaceholderShort` | "Suchen..." | "Search..." |
| `TranscriptSearchingDevices` | "Suche Geräte..." | "Searching for devices..." |
| `TranscriptSelectFromComputer` | "Vom Computer auswählen" | "Choose from your computer" |
| `TranscriptSelectInputDeviceHint` | "Wählen Sie ein Eingabegerät aus und starten Sie die Aufnahme." | "Select an input device and start recording." |
| `TranscriptSelectMicrophoneBelow` | "Wählen Sie unten ein Mikrofon aus und drücken Sie Aufnahme starten." | "Select a microphone below and press Start recording." |
| `TranscriptSelectMicrophoneHint` | "Wählen Sie ein Mikrofon und starten Sie die Aufnahme." | "Select a microphone and start recording." |
| `TranscriptSettingsDescription` | "Konfiguriere den Standard-Provider und das Modell für die Transkription." | "Configure the default provider and model used for transcription." |
| `TranscriptShow` | "Einblenden" | "Show" |
| `TranscriptShowAllSpeakers` | "Alle Sprecher anzeigen" | "Show all speakers" |
| `TranscriptShowOnlyThisSpeaker` | "Nur diesen Sprecher anzeigen" | "Show only this speaker" |
| `TranscriptShowSpeaker` | "Sprecher einblenden" | "Show speaker" |
| `TranscriptSidebarTitle` | "Transkription" | "Transcription" |
| `TranscriptSingleSpeaker` | "Einzelne Person" | "Single person" |
| `TranscriptSpeaker` | "Sprecher" | "Speaker" |
| `TranscriptSpeakerAnalysisRetryFailed` | "Die Sprecheranalyse konnte nicht wiederholt werden: " | "The speaker analysis could not be repeated: " |
| `TranscriptSpeakerAssignment` | "Sprecherzuordnung" | "Speaker assignment" |
| `TranscriptSpeakerN` | "Stimme {n}" | "Voice {n}" |
| `TranscriptSpeakerOptimizationError` | "Fehler bei der Sprecher-Optimierung: " | "Error during speaker optimization: " |
| `TranscriptSpeakerOptimizationRunning` | "KI-Optimierung läuft..." | "AI optimization in progress..." |
| `TranscriptSpeakerOptimizationSuccess` | "Sprecherzuordnung erfolgreich per KI optimiert!" | "Speaker assignment optimized with AI." |
| `TranscriptSpeakerOptimizationUnknownError` | "Unbekannter Fehler bei der Sprecher-Optimierung." | "Unknown error during speaker optimization." |
| `TranscriptSpeakers` | "Sprecher" | "Speakers" |
| `TranscriptStartNew` | "Neue Transkription starten" | "Start new transcription" |
| `TranscriptStartRecording` | "Aufnahme starten" | "Start recording" |
| `TranscriptStartRecordingFailed` | "Fehler beim Starten der Aufnahme" | "Could not start the recording" |
| `TranscriptStartTranscription` | "Transkription starten" | "Start transcription" |
| `TranscriptStartYourRecording` | "Starten Sie Ihre Aufnahme" | "Start your recording" |
| `TranscriptStatusLabel` | "Status" | "Status" |
| `TranscriptStopRecording` | "Aufnahme stoppen" | "Stop recording" |
| `TranscriptStopRecordingFailed` | "Fehler beim Beenden der Aufnahme" | "Could not stop the recording" |
| `TranscriptSubtitlePlaceholder` | "Ergebnisprotokoll bereit zur Prüfung" | "Summary ready for review" |
| `TranscriptSubtitleSaveFailed` | "Die Unterzeile konnte nicht gespeichert werden." | "The subtitle could not be saved." |
| `TranscriptSuccess` | "Erfolg" | "Success" |
| `TranscriptSupportedFormats` | "Wir unterstützen .mp3, .wav, .m4a und .ogg." | "We support .mp3, .wav, .m4a and .ogg." |
| `TranscriptTabCorrections` | "Korrekturen" | "Corrections" |
| `TranscriptTabExport` | "Export" | "Export" |
| `TranscriptTabLiveTranscription` | "Live-Transkription" | "Live transcription" |
| `TranscriptTabPreview` | "Vorschau" | "Preview" |
| `TranscriptTabRecord` | "Aufnahme" | "Recording" |
| `TranscriptTitleSaveFailed` | "Der Titel konnte nicht gespeichert werden." | "The title could not be saved." |
| `TranscriptToday` | "Heute" | "Today" |
| `TranscriptTotalFileSize` | "Dateigröße: {size} MB gesamt" | "File size: {size} MB total" |
| `TranscriptTranscribing` | "Transkription" | "Transcribing" |
| `TranscriptTranscriptionComplete` | "Transcription abgeschlossen" | "Transcription complete" |
| `TranscriptTranscriptionError` | "Fehler bei der Transkription: " | "Transcription error: " |
| `TranscriptUndoAction` | "Aktion rückgängig machen" | "Undo action" |
| `TranscriptUnknown` | "Unbekannt" | "Unknown" |
| `TranscriptUnknownError` | "Unbekannter Fehler" | "Unknown error" |
| `TranscriptUnredactBracketed` | "[Einblenden]" | "[Show]" |
| `TranscriptUnsupportedFileAlert` | "Wir unterstützen .mp3, .wav, .m4a und .ogg.\n\nMaximal 500MB pro Datei." | "We support .mp3, .wav, .m4a and .ogg.\n\nMaximum 500MB per file." |
| `TranscriptUploadAborted` | "Upload wurde abgebrochen." | "The upload was cancelled." |
| `TranscriptUploadForTranscription` | "Zur Transkription hochladen" | "Upload for transcription" |
| `TranscriptUploadSessionFailed` | "Konnte keine Upload-Session erstellen." | "Could not create an upload session." |
| `TranscriptUploadingFile` | "Dateiupload..." | "Uploading file..." |
| `TranscriptWaitingForAnalysis` | "Warte auf Analyse..." | "Waiting for analysis..." |
| `TranscriptWorkspaceDefaultTitle` | "Bearbeitung" | "Editing" |
| `TranscriptYesterday` | "Gestern" | "Yesterday" |
| `Transcription` | "Transkription" | "Transcription" |

## 5) JLU Campus mapping (proposal)

Everything in this section is a proposal based on [ARCHITECTURE.md](ARCHITECTURE.md), [shared contracts](../packages/shared/src/index.ts), [server translator module](../apps/server/src/modules/translator/index.ts), [document worker](../apps/server/src/modules/translator/documents.ts), and [web translator adapter](../apps/web/src/adapters/translator/index.ts). It does not describe kiChat internals. Full equivalence requires T-01 through T-63, subject to the explicit reference-validation gaps. Do not reduce this service to a single upload form or an iframe.

### Registration and module lifecycle

Use type `transcription`, default German name `Transkription`, English name `Transcription`, and microphone icon. Add the literal to `COMPONENT_TYPES` and `SINGLETON_COMPONENT_TYPES`, all component config/view/admin/input discriminated unions, `COMPONENT_SECRETS`, `COMPONENT_WIDGETS`, server registry and web adapter registry. Follow `ServerModule<'transcription'>` with `defaultName`, `defaultIcon`, `defaultConfig`, `configSchema`, `app`, `adminApp`, and `start` for the job worker/retention sweep.

Server startup creates exactly one disabled singleton row. Admins configure/enable it but cannot create a second instance, delete it or change its type. Ordinary endpoints are `/api/modules/transcription/*` with the existing session and enabled-module middleware. Missing/disabled module returns `404 not_found`. Admin endpoints `/api/admin/modules/transcription/*` run after the role check and load the row even while disabled. Use the module runtime's component ID as the owning instance for every job/record/template/format. Existing sidebar/dashboard component selection must work without a special navigation system.

Implement under `apps/server/src/modules/transcription/` and `apps/web/src/adapters/transcription/`. Suggested server files are `index.ts`, `engine.ts`, `jobs.ts`, `transcripts.ts`, `summaries.ts`, `templates.ts`, `realtime.ts`. Suggested web files are `index.ts`, `transcription-page.tsx`, `transcription-sidebar.tsx`, `upload-queue.tsx`, `speaker-mapping-dialog.tsx`, `transcript-editor.tsx`, `export-panel.tsx`, `template-editor.tsx`, `recording-panel.tsx`, `transcription-config-fields.tsx`, `transcription-tile.tsx`, and a state/query layer. These filenames are proposed, not a requirement to create each file regardless of module boundaries.

### Shared contract and proposed API

Put all HTTP body/response types and Zod validation in `packages/shared/src/index.ts`, as translator does. Export constants for the exact observed 524,288,000-byte upload validation and extension list; keep runtime limits admin-configurable. Use camelCase at the Campus boundary and map upstream snake_case inside the engine adapter. Use `API.module('transcription')` and `API.adminModule('transcription')`, not hardcoded kiChat paths.

Minimum shared schemas:

| Schema/type | Required fields and constraints |
| --- | --- |
| `TranscriptionLanguage` | `auto`, `de`, `en`; detected result language is a separate string |
| `TranscriptionSpeakerCount` | `auto`, `single`, `multi`; numeric counts are not a reference user control |
| `TranscriptionJobStatus` | `uploading`, `analyzingQueued`, `analyzing`, `analyzed`, `preprocessing`, `preprocessed`, `transcribing`, `optimizing`, `completed`, `failed`, `cancelled`; distinguish pending upload from queued analysis |
| `TranscriptionSessionInput` | filename, bytes, MIME, language, speaker count, optional group ID/order; enforce actual uploaded bytes server-side |
| `TranscriptionSpeaker` | stable ID, label/name, start/end seconds, samples with ranges, color ID; media served via authenticated/fresh URL endpoint |
| `TranscriptionDispatchInput` | mapping keyed by detected ID, snippets `{id,name,start,end}`, speaker count, boolean `llmCorrection`; time ranges finite/non-negative/end greater than start and within media bounds |
| `TranscriptionSegment` | stable ID, finite start/end, text, nullable speaker, redactions `{start,end}` as validated character offsets; preserve optional word/decoder metadata without allowing arbitrary executable HTML |
| `TranscriptionWord` | start/end, word/text and optional probability/speaker returned by adapter |
| `TranscriptionProgress` | phase, current/total chunks, optional estimated percent; absent/zero totals allowed |
| `TranscriptionJob` | opaque ID, filename, size, MIME, duration, captured settings, group/order, status/progress, speakers, error code/message, created/updated/expiry times, optional completed result; no upstream key/path credentials |
| `TranscriptionTranscript` | opaque ID, title, subtitle and subtitle source, detected language, duration, model/provider display IDs, segments, words, transcript text, source-file job IDs/ranges, speaker color map, created/updated times, revision, optional expiry/summary metadata |
| `TranscriptionPatch` | explicit title/subtitle/segments/color fields and base revision to prevent losing overlapping edits |
| `TranscriptionTemplateBlock` | discriminated union of heading with level 1–3, static text, divider, AI section with heading/instruction |
| `TranscriptionTemplate` | opaque ID, name, description, built-in flag, ordered structure, version and optional output hints; owner is derived from session |
| `TranscriptionFormat` | opaque ID, name, five booleans, chronological/speaker order; no per-speaker inclusion stored |
| `TranscriptionSummaryInput` | transcript ID or unsaved text, template ID/structure as allowed, force/check-only flags, optional allowed model; preview has explicit requested AI sections |
| `TranscriptionSummary` | Markdown plus transcript revision/template version/model identity; preview results keyed by section ID rather than ambiguous headings where possible |
| `TranscriptionCapabilities` | enabled batch/diarization/correction/summary/realtime modes, models, maximum bytes/duration/count/rate limits, retention policy; do not advertise disabled capabilities as working |

IDs/positive durations/offsets/name and prompt length limits must be bounded in schemas. Preserve the observed UI title limits of 255 in workspace and 35 in history context editing. Backend/name/prompt limits beyond these were not revealed, so exact values require Q-04/Q-05 rather than silently claiming parity. A revision field and section IDs are proposed robustness improvements; preserve reference behavior at the UI level while translating template structure as needed.

Proposed endpoints:

| Endpoint under `/api/modules/transcription` | Purpose and reference coverage |
| --- | --- |
| GET `/capabilities` | Safe provider/model choices, modes, limits, defaults, retention; T-09/59/63 |
| POST `/jobs` | Create resumable job and upload authorization, T-03–10 |
| PUT `/jobs/:id/audio` | Stream upload with server byte cap, or return restricted signed PUT from job creation for configured object storage |
| POST `/jobs/:id/analyze` | Automatic speaker analysis after upload; accept measured duration as hint, verify server-side |
| GET `/jobs` | Owner's active jobs for resume; include group/order where supported |
| GET `/jobs/:id` | Status, progress, speakers and completed result; frontend polls every two seconds while active |
| POST `/jobs/:id/dispatch` | Mapping, snippets, speaker count, correction; reject repeat dispatch safely |
| DELETE `/jobs/:id` | Cancel and delete uploaded/intermediate media; owner check; return a stable result on repeated deletion |
| GET `/jobs/:id/audio` | Authenticated audio streaming/range requests or short-lived URL; no permanent bearer URLs in stored frontend state |
| GET `/jobs/:id/samples/:sampleId` | Authenticated sample playback/fresh URL |
| POST `/transcripts` | Atomically save ordered group results once, idempotency key/group ID; T-13/14/15 |
| GET `/transcripts` | Owner history metadata, date sorting/title filtering; preserve reference no-page behavior in UI even if server pagination is added |
| GET `/transcripts/:id` | Full detail with editable segments/colors and source files |
| PATCH `/transcripts/:id` | Title/subtitle or segment/color edits with revision conflict check |
| DELETE `/transcripts/:id` | Owner record deletion plus defined media cleanup policy |
| POST `/speaker-optimization` | Current segments plus transcript/revision when saved; validate allowed engine |
| GET/POST `/formats`, DELETE `/formats/:id` | User transcript presets |
| GET/POST `/templates`, DELETE `/templates/:id` | Built-ins plus user summary templates; built-ins immutable to users |
| POST `/summaries` | Normal/cached/forced summary generation with Markdown response |
| POST `/summaries/preview` | Selected AI-section results with explicit stale/cache semantics |
| GET `/realtime/config` | Available on-prem/OpenAI modes and defaults |
| POST `/realtime/onprem/signaling` | Server signaling proxy, safe SDP response |
| POST `/realtime/session` | Short-lived OpenAI credential/session creation |

Use the existing API error envelope `{error:{code,message,issues?}}`. Map unavailable engine to `module_unavailable`, bad input to `validation`, ownership/missing data to `not_found`, changed revisions to `conflict`, quota to `rate_limited`, and upstream/internal failures to suitable safe errors. Add a structured transcription error detail only through a shared schema. Keep human messages localized in web, with useful backend detail where safe. HTTP authentication must work for the web, PWA and Electron API origins already supported by the repo. Every media/template/format/job/transcript route must derive user identity from the session, never a submitted `userId`.

### Backend services and job processing

The admin-configurable primary adapter is OpenAI-compatible, with HTTPS base URL, encrypted API key and allowed speech models. It should support multipart `/audio/transcriptions` and Whisper-style verbose JSON including timestamps, mapped into the shared segment model. For a standard compatible engine send supported fields such as file/model/language/response format, and omit `auto` language instead of sending it as a literal unsupported language code. Exact provider request options must be checked against the configured endpoint's contract. The reference browser reveals the orchestration API, not that provider request contract.

A bare OpenAI-compatible speech endpoint cannot supply all reference features. Full parity also needs diarization/sample extraction, voice matching from named samples, normalization/chunking, LLM correction, summary generation/speaker optimization, and realtime signaling. Model these as separate capabilities behind server adapters. Allow either a combined compatible transcription-job gateway with the observed operations or independent ASR/diarization/LLM/realtime services. If the selected backend lacks diarization, the module must clearly report unavailable capability or use a configured diarizer; silently assigning every segment to one voice fails T-17–21/28–31. Likewise an unavailable summary/realtime engine does not satisfy parity by hiding its tab.

Normalize media in a server process to valid PCM audio for the chosen engine; preserve original media for playback. Validate content/decoding independently of filename, support accepted MP4 audio extraction, and enforce byte/duration caps before expensive processing. Do not buffer 500 MiB source files repeatedly in Node/Postgres memory. Use configured object storage or disk with opaque owned object IDs. Derive duration from actual media inspection. Provide HTTP range playback and fresh sample links. Long-file chunk size/overlap and speaker consistency require Q-06; the observed short file alone cannot determine them.

Use durable PostgreSQL jobs and a worker, not browser-owned progress. The translator's `documents.ts` provides a pattern for non-overlapping sweeps, database claims, expiry cleanup and startup lifecycle. Do not copy its product quotas/retention into transcription as observed facts. A worker should atomically claim a job with lease timestamps so multiple server processes cannot process it twice; persist every status transition, chunk progress, settings and results. Distinguish transient upstream failures from terminal media errors, bound retries, recover stale claims after restart, honor cancellation, and never redispatch solely because a browser reconnects. Backend parallelism is configurable. Preserve frontend group sequencing/results ordering independently of worker execution order.

Persist completion before returning status. Save a group transaction once with an idempotency key; retain partial completed results for retry. Make expiry/cancellation/deletion stop work and clean originals, normalized audio, samples, chunks and cached exports as policy permits. Keep deletion of a record separate from deletion of shared source media until reference retention/cascade policy is resolved. Return deletion errors to the UI; do not duplicate the reference's unchecked-delete disappearance.

Summary/correction adapter should be an admin-configurable OpenAI-compatible chat endpoint, encrypted key, allowed models and timeout. Templates are instructions plus static blocks. Apply placeholders using real transcript title/date/participants/duration; do not use the reference's sample fallback data for saved transcripts. Render Markdown safely, retain lists/tables in summary export, and cache by transcript revision + template version + model + settings. Invalidate after edits/redactions/name changes, and make forced regeneration explicit. For saved transcripts, ensure summary generation respects redaction and speaker inclusion only as the approved reference policy requires; that policy is Q-10. Speaker optimization must preserve text/timing and save through the same revision/undo path.

On-prem realtime requires the configured signaling gateway and any ICE/TURN requirements; credentials stay server-side or are ephemeral. OpenAI realtime requires a server-issued ephemeral key and provider-supported session/model settings. Treat the deployed model string in section 3 as reference evidence, not assurance that any compatible endpoint offers that model. Browser microphone/MediaRecorder access must work in web/PWA and Electron permission handlers; capability denial yields T-55 feedback. Release media resources on stop/unmount/sign-out and avoid losing final transcription events during drainage.

### Storage and retention proposal

Add Drizzle tables with component/user foreign keys and migrations in implementation. Do not create migrations in this research task.

| Table | Minimum data and indexes |
| --- | --- |
| `transcription_job` | ID, component/user IDs, group/order, filename/MIME/bytes/duration, media object references, status, settings, speakers/snippets/mapping/colors, result, progress/error, upstream opaque job ID, claimed/heartbeat/retry/cancel timestamps, created/updated/expiry/deleted timestamps. Index owner/date, status/claim, expiry |
| `transcription_transcript` | ID, component/user IDs, title/subtitle/source, language/duration/model/provider, segments/words/transcript text, source files/colors, revision, selected summary template, created/updated/expiry/deleted timestamps. Index owner/updated time and expiry |
| `transcription_template` | ID, component ID, nullable owner for built-ins, name/description/structure/version/output hints, timestamps. Users cannot mutate built-in rows |
| `transcription_format` | ID, component/user IDs, name/flags/order, timestamps |
| `transcription_summary` | Transcript/owner/component IDs, template ID/version, transcript revision, model/settings hash, Markdown or section results, generated/expiry timestamps |

Reference history persists server-side across visits, but no expiry interval or retention notice was observed. Therefore use an explicit policy option such as `retentionHours: null | positive integer` with a separately configurable temporary-job retention; null means no automatic deletion. Leave the production default unresolved pending Q-03. Translator's 24-hour document retention is a pattern, not transcription evidence. Once chosen, capabilities/UI must explain retention, and expiry must remove all owned derivatives according to that policy. Preserve created/updated times and time-zone-local history grouping. Keep upstream result metadata needed for exports without storing signed URLs as durable object identifiers.

### Admin config and encrypted secrets

Follow translator's `ConfigFields` and the existing `SecretField` handling. Declare secret names in `COMPONENT_SECRETS.transcription`; ciphertext lives in `component.secrets` with AES-256-GCM under `COMPONENT_SECRETS_KEY`, random 12-byte IV and AAD `<component id>:<secret key>`. Admin responses expose only set/unset booleans. Absent leaves unchanged, string replaces, null deletes. No ordinary/admin GET returns a decrypted key.

| Proposed field | Purpose/default policy |
| --- | --- |
| `backendMode` | `openaiCompatible` plus independent services, or `jobGateway`; choose deployed backend before enabling |
| `baseUrl`, `models`, `defaultModel` | Speech endpoint and allowed ID/display-label pairs; no baked-in production hostname/key |
| `apiKey` secret | Speech/gateway credential, server only |
| `diarizationBaseUrl`, `diarizationModel`, `diarizationEnabled` | Voice analysis/snippets/matching provider; required for full parity |
| `diarizationApiKey` secret | Separate diarizer credential if needed |
| `llmBaseUrl`, `llmModels`, `defaultCorrectionModel`, `defaultSummaryModel` | Correction, speaker optimization, summary/preview backend |
| `llmApiKey` secret | Chat-compatible credential |
| `defaultLanguage`, `defaultSpeakerCount`, `defaultLlmCorrection` | `auto`, `auto`, true to match observed defaults |
| `maxFileBytes`, allowed formats | Default proposal 524,288,000 bytes and observed five extensions; validate actual media too |
| `maxDurationSeconds`, `maxFilesPerGroup`, `maxActiveJobsPerUser`, concurrency, daily/rate quotas, upstream/job timeouts | No observed reference values; explicit configurable values require Q-04/Q-05 |
| transcript and temporary-job retention, storage backend/object bucket | No observed lifetime; require Q-03 and deployment storage decision |
| `realtimeModes`, `defaultRealtimeMode`, `onpremSignalingUrl`, ICE server configuration | On-prem/OpenAI modes, proposed default onprem when configured |
| realtime/OpenAI/TURN secrets | Declare separately only where backend requires; issue short-lived client credentials |
| feature/capability flags | Report operational state; flags cannot waive equivalence requirements without an approved scope change |

Provide admin-only model discovery and connection tests under `API.adminModule('transcription')`, including operation while disabled. For model discovery, reuse the translator's typed request/fetched-model display-name pattern, but do not apply its chat-only filtering to speech models. `/models` alone does not prove audio support. Verify a configured model is allowed, report diarization/realtime/LLM capability separately, and retain manual model configuration when discovery is absent. Never send raw decrypted keys back as a response to connection tests.

### Web layout and design-system components

Use `ComponentAdapter<'transcription'>` with `Page`, `ConfigFields`, `defaultConfig`, and declared widgets. Match Campus shell navigation, `PageHeader`, component icon and existing `PageSidePanel`. At the wide breakpoint used by `SIDE_PANEL_MEDIA`, put settings/tools on the right in the collapsible/resizable side panel, as translator does. Below that breakpoint use a mode selector above the content and a settings Card or dialog that does not cover the whole working area. History can be a work-area list/subview; do not introduce kiChat's second fixed left navigation rail into the Campus shell.

All visible controls and visual containers must come from `@ki4jlu/design-system`. Repo examples establish the following components. Use layout classes and design tokens, lucide icons with accessible labels, and existing shell wrappers. The source reference's inline colors, Tailwind-like custom buttons and raw modal markup are not reusable Campus components.

| Area | Proposed supported components and behavior |
| --- | --- |
| Entry/modes | `Card`, `CardHeader`, `CardTitle`, `CardContent`, `Button`, `SegmentedControl`, `NavItem`, `PanelSection` |
| Upload queue/groups | Cards, `Input` for file/name, Buttons, `Badge` for status, `Spinner` plus percentage/status text. Repo documents that its DS has no Progress component; do not invent one or copy the translator's custom bar under the DS-only requirement |
| Settings | `Label`, `Select` family for language/count/model/device/provider, `Switch`/`Checkbox` for correction and formatting |
| Speaker mapping | `Dialog` family, Input/Label, Buttons, Cards, tooltips; DS controls operate audio-window selection and preset avatar colors |
| Audio/waveform | Media/canvas primitives inside DS containers, DS play/pause/seek Buttons and Input control. Canvas/audio are media internals, not replacements for visual buttons |
| Result editing | `SegmentedControl`, Cards, `Textarea`/Input or an accessible text editor in DS framing, Buttons/DropdownMenu for attribution and insertion, Badge/avatar indicators |
| History | Input search, DS list Cards or `Table` family, `DropdownMenu` actions, Dialog deletion confirmation |
| Export | Select format/category, Switch/Checkbox flags, Buttons, readable preview Card; built-in preset list and speaker chips use DS controls |
| Template chooser/editor | Dialog, Input, Textarea, Buttons, SegmentedControl/Select for block kind/heading level; keyboard move-up/down actions accompany drag |
| Recording/live | Buttons, Select device/mode, Badge/Spinner status, Input for font size/range where supported, Switch contrast, accessible maximize button |
| Errors/empty states | DS Card/Badge/text plus retry/cancel Buttons, Dialog where appropriate; use a DS-exported alert if available rather than assuming a component exists |

Do not silently remove waveforms, samples, correction actions or template editing because the design-system library lacks a specialized transcription widget. Compose DS controls with media primitives. If a genuinely required visual control cannot be composed from existing DS primitives, record a DS dependency task instead of introducing a second UI library.

Use TanStack Query for capabilities/history/detail/formats/templates; invalidate after saves/deletes. Poll active jobs only while active and stop after terminal states. Maintain UI queue grouping and editor state independently of request order, with stale-request guards. Keep undo and local recording blobs in memory. Any persisted draft/cached template preview must be scoped to user/module and cleared on sign-out so shared devices do not reveal another user's transcript. No raw audio in localStorage. Capability/error states must be represented in web and PWA/Electron consistently.

Accessibility acceptance is proposed Campus quality, not verified reference compliance: label every icon control, expose requesting/processing/saved/error status via appropriate live regions, keep focus inside dialogs and restore it on close, allow file picking without drag, allow keyboard ordering without drag, support selection/correction without touch-only actions, give playback controls names and times, maintain contrast, and preserve focus when polling replaces rows. Do not use color alone for speaker identity/status. Test narrow widths without horizontal loss of the working area.

### Dashboard widgets and i18n

Proposed widget key `quick` matches translator's small-launcher approach. It shows the microphone/name, "Neue Transkription" / "New transcription", optional active-job count, and opens the module's upload or recording entry. It must remain useful at TILE_MIN_W/TILE_MIN_H; no full waveform/editor in a small tile. A second `recent` widget is optional product work: list the user's newest saved transcripts and processing statuses with owner-safe navigation. Dashboard widgets, placement, dimensions and quick actions were not observed in kiChat and are not T-items.

Use the app's de/en language state and i18n namespaces, without reimplementing `/req/changeLanguage`. Suggested module labels are `component.transcription.name`, `transcription.modes.upload/record/live`, `transcription.jobs.*`, `transcription.speakers.*`, `transcription.editor.*`, `transcription.export.*`, `transcription.templates.*`, `transcription.recording.*`, `transcription.errors.*`, and `component.transcription.secrets.<key>`. Import the section 4 pairs into this structure with explicit mapping so reviewers can compare labels by reference key. User-created names/prompts and stored transcript content are not UI translations. Preserve German built-in template content unless Q-12 approves English copies. UI locale and detected/spoken language are separate settings.

### Implementation and review gates

Review T-01–63 individually, recording automated, manual, source-only or unresolved validation per item. Required end-to-end checks are supported audio to persisted transcript, multi-file ordered merge, multiple speakers with snippet mapping/correction, reload during jobs, recording and both realtime modes on a permitted microphone, every export format including DOCX, summary/template CRUD and previews, ownership rejection, configured limit failures, deletion/retention cleanup, de/en and narrow layout. Use deterministic stored-segment fixtures for export/redaction/undo tests and controlled upstream adapters for job/error tests; engine-generated prose is not a byte-equality assertion. Normal unlocked reference validation must close the gaps before a full-equivalence claim.

## 6) Out of scope / not observable

The following were not offered by the inspected transcription UI/source and must not be inferred as reference requirements: translation of transcript, chat with transcript, transcript sharing/public links, bulk history deletion, folders/tags, full-content search, server export jobs, arbitrary batch prompt, arbitrary language list, numeric speaker count, pause recording, and collaborative editing. Summary and AI speaker optimization are the observed follow-up actions. Absence in this inspected frontend is not proof that no admin/other account can enable more features.

Account encryption recovery, chat history/keychain reset, institution-wide auth administration and unrelated kiChat tools are outside this transcription port. Existing Campus authentication supplies access. No destructive reset was attempted. No backend load/rate-limit test, 500 MiB real upload, long recording, large video or long multi-speaker transcription was run. The only completed media transcription was the short generated WAV.

Backend implementation code, exact engine versions, queue/storage deployment, GPU topology, backend prompt templates and policy, retention period, real limits beyond frontend per-file bytes, long-file chunk size/overlap, token/confidence interpretation, cost/billing, and cross-account access enforcement were not observable. A raw provider-key field was seen but is neither documented nor reusable. Do not use frontend inference as evidence of server guarantees.

Microphone permissions were denied in this headless session. Recordings and live connections are source-defined and visually explored but not successful runs. DOCX generation did not finish in the instrumented page, so its download success and output fidelity remain unverified. Some global handlers, provider settings and mobile layout were affected or potentially affected by instrumented page initialization. Screenshots alone cannot distinguish all such effects from production behavior.

## 7) Open questions

| ID | Question and evidence gap | Required resolution / effect |
| --- | --- | --- |
| Q-01 | Can the test account be normally unlocked with its existing recovery code? | Owner supplies recovery code or another normally usable test session. Re-run normal navigation, global handlers, settings and mobile without suppression; do not reset encryption |
| Q-02 | Is the provider/model settings modal intentionally available for transcription? Functions/select markup exist but modal element was absent; provider list disagrees with current speech provider | Owner confirms intended reachability and allowed speech models. Validate selection/save and setting scope before claiming T-63 |
| Q-03 | What are history, original audio, normalized chunks, snippets, failed-job and summary retention periods? Does record deletion erase media/jobs, and when? | Inspect backend/policy or observe expiry with an agreed fixture. Decide Campus retention/default/cascade and display accurate notice |
| Q-04 | What are server file/duration/count/aggregate/rate/daily/active-job limits and 429/error payloads? MP4 support is source-only; UI prose lists four audio extensions | Obtain backend limits or controlled fixtures; configure Campus values and validate media rather than inventing quotas |
| Q-05 | What are backend model/prompt/name/snippet limits, request/job timeouts, retry rules and numeric progress semantics? | Backend contract needed for bounded schemas/worker behavior. Reference client polls indefinitely; production Campus needs agreed timeout/error handling |
| Q-06 | How do long-file chunk overlap, silence, group timing and speaker identities work across files/chunks? Reference merge falls back to last segment end, which was 10.72 s for 11.24 s audio | Multi-file/multi-speaker/long fixture and backend contract. Decide whether Campus preserves reference timing mismatch or corrects it explicitly |
| Q-07 | Does changing language after automatic upload/session creation affect the job? Session captures language; dispatch does not visibly resend it | Run another fixture with settings changed after analysis. Make effective settings clear and correct before porting |
| Q-08 | Do successful regular recording and both on-prem/OpenAI live modes work, with which devices, browser support and models? | Test with permitted microphone, final-drain events and local WAV upload. Confirm realtime signaling/ICE/provider errors and file limits |
| Q-09 | Why did DOCX Packer remain pending? Library/runtime, instrumentation, or reference defect? | Repeat DOCX export on normally unlocked browser; verify summary/transcript formatting, tables/Unicode/page flow and downloads |
| Q-10 | Are saved-slug summaries/optimization redaction-aware? Do filtered speakers affect summaries, subtitles, JSON, or only formatted transcript? | Backend summary assembly and multi-speaker redaction tests needed. JSON demonstrably retains source text; never imply redaction is erasure. Summaries: answered 2026-10-07, kiChat's saved-slug summaries ignore redactions; Campus redacts on purpose (T-49) |
| Q-11 | What is normal mobile panel behavior? Expanded sidebar consumed 320 px of a 390 px viewport; instrumented global state prevented reliable collapse conclusion | Test unlocked mobile/touch portrait/landscape across upload, mapping, corrections, template editor/live. Campus must remain usable with right-panel integration |
| Q-12 | Should built-in templates and hardcoded German labels be translated into English? The server returned five German built-ins; player/placeholder/redaction marker stayed German | Product approves translation policy and exact English templates. Section 4 preserves current reference for comparison |
| Q-13 | What are AI correction, summary, subtitle/title and speaker-optimization prompts/models, cache invalidation rules and failure details? | Backend owner provides contracts; require behavior/persistence equivalence rather than exact generated prose. Confirm manual subtitle wins async generation |
| Q-14 | Does active-job resume preserve grouping server-side in normal UI? Current deployed source explicitly restores each job as a separate group | Test non-empty reload/resume/failed-save scenarios. Decide whether preserving grouping in Campus is an approved improvement |
| Q-15 | Are legacy manual speaker inputs and summary model selector intended reachable controls? Only deployed functions/branches were found | Owner identifies reachable path or confirms obsolete code. Do not make speculative controls a completed parity claim |
| Q-16 | What are production ownership and deletion failure behavior, and how should reference 500/missing-model/framework disclosures map? | Controlled second-account/backend tests. Campus uses session ownership, safe error envelopes and correct missing-resource semantics; retain visible failure/retry requirements |

The document has 63 checklist items and 16 open questions. A completed implementation can tick demonstrated behaviors immediately, but a full feature-equivalence sign-off must state how each unresolved reference workflow was verified or explicitly waived by the owner.
