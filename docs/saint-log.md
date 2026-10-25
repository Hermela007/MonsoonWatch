# Saint log (required for submission)

What we asked Saint (agent: **Thea**) to do, which tools and accounts it used, and where it stopped to ask for approval. Keep adding entries during the weekend. **No phone numbers or personal details here.**

## Access and tools
- **Access:** Encode Club guest trial, per person. Our team members each message Thea on WhatsApp; Thea sees one conversation at a time.
- **Tools available to Thea (guest setup):** WhatsApp messages to cleared contacts only; drafting and translation (English, Malay).
- **Not available (stated by Thea, Sat 24 Oct ~15:00):** web research, files/spreadsheets, email, running code or calling APIs, scheduling or background work, and any spending or real orders.

## Entries
| When (Sat 24 Oct) | We asked | Thea's response / what it did | Approval asked? |
|---|---|---|---|
| ~09:45 | What it can do: messaging others, sheets, web/APIs, how it asks for approval, what it needs | Described WhatsApp + email messaging to agreed contacts, sheets, web/API access; asks before risky actions; spending needs Saint team sign-off | — |
| ~14:40 | Research task: official figures (OKU, vehicles, 2014 gauge peaks, PPS list) and a sourced knowledge base | **Declined**: no web access in guest setup; refused to invent figures or URLs; offered unsourced drafts, which we declined | — |
| ~15:00 | Exactly what works in the guest setup | WhatsApp to cleared contacts only; no web/files/email/APIs/scheduling; never spends money | — |
| Sat afternoon | Act as coordinator after alert approval; clear our test community leader (a teammate playing the ketua kampung) as a contact; agree the `MW CHECKIN` report format | Accepted the role; would fill only `people=`/`status=` from what the leader says and flag any centre change | — |

### First end-to-end test (Sat 24 → Sun 25 Oct, London time; MYT = +7 h)
| When | We asked | Thea's response / what it did | Approval asked? |
|---|---|---|---|
| ~00:15 | Forward a brief (by mistake, a leaked automated-test alert: English only, no recipient number) | **Refused to send.** Pointed out the missing Malay text and would not write her own translation as "approved"; asked us to confirm the recipient. Flagged that the app should refuse such alerts | **Yes**: asked whether to send English only, and who the recipient was |
| 00:12–00:18 | Real alert approved in the app (Kampung Kual, Pasir Mas; flood ALERT; 400 people → SK To' Uban, 4.6 km), then the brief sent to Thea via the app's WhatsApp link | Received the brief | — |
| ~00:20 | Send the alert to the village head (our cleared test leader) | Sent the Malay then the English text verbatim, without the [BM]/[EN] markers. Flagged three issues: the brief's 4.9 km vs the message's 4.6 km, a centre filled to 100% of its estimated capacity, and pickups not described in the message. **Held back the check-in line** until a person replied | Asked whether "acknowledged" should mean "sent" or "a person confirmed" (we chose: a person confirmed) |
| ~00:22 | (Brief had not asked her to question the leader) We asked her to get receipt, numbers moving and arrival | Asked the leader in Malay and English | — |
| ~00:27–00:32 | Follow-up with the leader | Kept a running tally (80 walking, 100 awaiting pickup incl. 18 needing accessible transport, ~220 still to move); asked about vehicles, door-to-door pickup and ETA; recommended asking the district for extra transport early. Marked every message as a demo | — |
| ~00:37 | Send us the `MW CHECKIN` lines | Sent three lines. Left `people=` **empty** on "acknowledged" rather than invent a number, and **flagged that no reply from the leader had reached her in our conversation**, so the figures were not confirmed by the leader | Asked us to confirm the figures' source, or label them scripted |

**What we changed after this test** (branch `c/saint-fixes`): the app refuses to hand over an alert without both Malay and English; the brief's distance now comes from the approved message; pickup categories read as words; the brief tells Thea to ask the leader for receipt and numbers and never to fill in a number herself; `people=` may be empty on "acknowledged"; the automated test can no longer write to the shared database.

**Open question:** each person's conversation with Thea appears to be separate, so the leader's replies may not reach the officer's chat. Asked the Saint team (Encode Club) whether Thea can relay between two cleared contacts. Until then, the check-in line is relayed by a person and pasted into the app by the duty officer.

| _next_ | Second test with the new brief: the leader sends a number only she knows, to check where the check-in figures come from | | |
