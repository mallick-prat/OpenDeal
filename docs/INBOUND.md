# Inbound pitch mailbox (optional)

Turn a shared Gmail address (for example `deals@yourfund.com`) into the top of
your funnel. Founders email it, or your team forwards or CCs it on a pitch.
Claude reads the email and any attached or linked deck and drafts a deal. A
person reviews the draft in **Inbound** and clicks **Create deal** or **Skip**.
Nothing is created automatically.

```
Pitch → deals@yourfund.com → ingest (cron, Poll now, or Gmail push)
   → parse email + deck (Claude) → Inbound queue (private draft)
   → member reviews → Create deal  /  Skip
```

## Requirements

- A real Google mailbox for the address (a Workspace user or a Gmail account;
  an alias or Google Group has no account to sign in to).
- Google OAuth set up ([SETUP.md](SETUP.md), B3 Option 1) with the **Gmail API**
  enabled in Google Cloud.
- `ANTHROPIC_API_KEY` for extraction.

## Turn it on

1. Set `NEXT_PUBLIC_INBOUND_MAILBOX=deals@yourfund.com` in Vercel and redeploy.
2. As an admin open **Settings, Inbound deals mailbox, Connect sourcing mailbox**.
3. Sign in **as that mailbox** and grant Gmail read and modify access. The app
   rejects any other account, so it cannot be pointed at the wrong inbox.
4. The card shows when it last polled. Click **Poll now** to test: send the
   address a pitch and it appears in **Inbound**.

Processed messages get a Gmail label (`CRM/Ingested`) so nothing is read twice.

## How often it syncs

| Mechanism | Latency | Setup |
| --- | --- | --- |
| Daily cron (`vercel.json`) | up to a day | none |
| **Poll now** button | immediate | none |
| More frequent cron | minutes | edit `vercel.json` (for example `*/10 * * * *`); may need a paid Vercel plan |
| Gmail push (Pub/Sub) | seconds | below |

### Gmail push (optional, real-time)

1. Google Cloud: create a Pub/Sub topic. Grant `gmail-api-push@system.gserviceaccount.com`
   the **Pub/Sub Publisher** role on it.
2. Create a **push** subscription with endpoint
   `https://<your-domain>/api/inbound/push?token=<INBOUND_PUSH_SECRET>`.
3. Set `GMAIL_PUBSUB_TOPIC=projects/<gcp-project>/topics/<topic>` and
   `INBOUND_PUSH_SECRET` (any long random string), redeploy, and reconnect the
   mailbox so the watch is armed.

### Webhook alternative (Resend inbound)

If you would rather not use Gmail: point Resend inbound mail at
`https://<your-domain>/api/inbound/email?token=<INBOUND_WEBHOOK_SECRET>` and set
`RESEND_API_KEY` and `INBOUND_WEBHOOK_SECRET`. Requests without the token are
rejected. Generic multipart/JSON inbound-parse payloads (SendGrid, Mailgun,
Postmark) are also accepted; for providers that deliver attachments as URLs,
list their file hosts in `INBOUND_ATTACHMENT_HOSTS`.

## Decks

- **PDF attachments** are read directly by Claude.
- **DocSend links** need the `docsend-to-pdf` CLI (Python plus a headless
  browser) on the host. Vercel functions do not have it, so DocSend decks are
  recorded as links for manual review unless you run ingestion elsewhere.
  Set `DOCSEND_TO_PDF_CMD` and `DOCSEND_VIEWER_EMAIL` if you do.
- **Other links** (Drive, Notion, pitch.com) are saved on the draft for manual review.

## Threads

The first message on a Gmail thread creates the draft. Later replies attach
their files to it but never re-run extraction, so edits a person made are never
overwritten, and a reply never creates a second queue item.
