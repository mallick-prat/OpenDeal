import { describe, it, expect } from "vitest";
import { parseEmailThread, parseEmailDate } from "../emailThread";

/* Fixtures mirror the real shapes our inbox receives; content is invented. */

const GMAIL_CHAIN = `---------- Forwarded message ---------
From: Ada Lovelace <ada@fund.com>
Date: Sun, Jul 26, 2026 at 12:12 PM
Subject: Fwd: FW: Northwind
To: Ada Lovelace <ada@fund.com>, <inbox@fund.com>




---------- Forwarded message ---------
From: Bo Peep <bo@fund.com>
Date: Mon, May 18, 2026 at 7:55 PM
Subject: Fwd: FW: Northwind
To: Ada Lovelace <ada@fund.com>


Meet/kill?

---------- Forwarded message ---------
From: Cy Scout <cy@scout.club>
Date: Mon, May 18, 2026 at 4:18 PM
Subject: FW: Northwind
To: Bo Peep <bo@fund.com>


Any interest in this team? Happy to intro.

*From: *Dara Founder <dara@northwind.io>
*Date: *Monday, May 18, 2026 at 1:38 PM
*To: *cy@scout.club <cy@scout.club>
*Cc: *Eve Cofounder <eve@northwind.io>
*Subject: *Northwind

Hi Cy,

We are building the thing. Raising a small pre-seed.

Best,
Dara`;

const REPLY_CHAIN = `Sounds good, let's pass.

On Wed, Jun 3, 2026 at 2:51 PM Bo Peep <bo@fund.com> wrote:

> Terms were $45m cap.
>
> On Tue, Jun 2, 2026 at 9:15 AM Ada Lovelace <ada@fund.com> wrote:
>
>> What were her terms?
>>`;

describe("parseEmailThread", () => {
  it("unrolls a Gmail forward chain oldest-first", () => {
    const zones = parseEmailThread(GMAIL_CHAIN);
    expect(zones.map((z) => z.from.email)).toEqual([
      "dara@northwind.io",
      "cy@scout.club",
      "bo@fund.com",
    ]);
    expect(zones[0].subject).toBe("Northwind");
    expect(zones[0].cc).toEqual(["Eve Cofounder <eve@northwind.io>"]);
    expect(zones[0].body).toContain("building the thing");
    expect(zones[2].body).toBe("Meet/kill?");
  });

  it("drops the empty forward wrapper but keeps every message with text", () => {
    const zones = parseEmailThread(GMAIL_CHAIN);
    // Ada's outer forward carried no note of its own.
    expect(zones.some((z) => z.body === "")).toBe(false);
    expect(zones).toHaveLength(3);
  });

  it("orders by parsed date, and exposes ISO timestamps", () => {
    const zones = parseEmailThread(GMAIL_CHAIN);
    const times = zones.map((z) => Date.parse(z.sentAt!));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(zones[0].sentAt).toBe("2026-05-18T17:38:00.000Z");
  });

  it("splits `On … wrote:` replies and strips nested > quoting", () => {
    const zones = parseEmailThread(REPLY_CHAIN, { from: "Ada <ada@fund.com>" });
    expect(zones).toHaveLength(3);
    expect(zones.map((z) => z.from.email)).toEqual([
      "ada@fund.com",
      "bo@fund.com",
      "ada@fund.com",
    ]);
    expect(zones[0].body).toBe("What were her terms?");
    expect(zones[1].body).toBe("Terms were $45m cap.");
    expect(zones[2].body).toBe("Sounds good, let's pass.");
    // No quote markers survive into the rendered body.
    expect(zones.every((z) => !z.body.includes(">"))).toBe(true);
  });

  it("treats a plain unforwarded email as a single zone", () => {
    const zones = parseEmailThread("Just a normal pitch, no history.", {
      from: "Dara <dara@northwind.io>",
      subject: "Northwind",
    });
    expect(zones).toHaveLength(1);
    expect(zones[0].from.email).toBe("dara@northwind.io");
    expect(zones[0].subject).toBe("Northwind");
  });

  it("returns nothing for empty input", () => {
    expect(parseEmailThread("")).toEqual([]);
    expect(parseEmailThread("   \n  ")).toEqual([]);
  });

  it("assigns depth in display order", () => {
    const zones = parseEmailThread(GMAIL_CHAIN);
    expect(zones.map((z) => z.depth)).toEqual([0, 1, 2]);
  });
});

describe("parseEmailDate", () => {
  it("handles the Gmail 'at' form", () => {
    expect(parseEmailDate("Mon, May 18, 2026 at 4:18 PM")).toBe("2026-05-18T20:18:00.000Z");
  });
  it("handles the Outlook long form", () => {
    expect(parseEmailDate("Monday, May 18, 2026 at 1:38 PM")).toBe("2026-05-18T17:38:00.000Z");
  });
  it("honours an explicit zone instead of assuming Eastern", () => {
    // Named, parenthesised, numeric, and RFC 2822 — all absolute already.
    expect(parseEmailDate("Mon, May 18, 2026 at 1:38 PM PDT")).toBe("2026-05-18T20:38:00.000Z");
    expect(parseEmailDate("Mon, May 18, 2026 at 1:38 PM (UTC)")).toBe("2026-05-18T13:38:00.000Z");
    expect(parseEmailDate("Mon, 18 May 2026 13:38:00 -0700")).toBe("2026-05-18T20:38:00.000Z");
  });
  it("reads a winter date at standard time, not summer time", () => {
    expect(parseEmailDate("Tue, Jan 6, 2026 at 9:00 AM")).toBe("2026-01-06T14:00:00.000Z");
  });
  it("does not depend on the process timezone", () => {
    // The regression this guards: Date.parse resolved a zoneless header
    // against TZ, so the server and a laptop disagreed by hours.
    const tz = process.env.TZ;
    const readIn = (zone: string) => {
      process.env.TZ = zone;
      return parseEmailDate("Mon, May 18, 2026 at 4:18 PM");
    };
    try {
      expect(readIn("UTC")).toBe("2026-05-18T20:18:00.000Z");
      expect(readIn("Asia/Tokyo")).toBe("2026-05-18T20:18:00.000Z");
    } finally {
      process.env.TZ = tz;
    }
  });
  it("reads RFC 2822 and ISO headers without losing the zone", () => {
    // Day-first RFC 2822 isn't modelled directly; it falls through to the
    // platform parser, which must still not see a zoneless string.
    expect(parseEmailDate("Mon, 18 May 2026 13:38:00")).toBe("2026-05-18T17:38:00.000Z");
    expect(parseEmailDate("Mon, 18 May 2026 13:38:00 GMT")).toBe("2026-05-18T13:38:00.000Z");
    expect(parseEmailDate("2026-05-18T13:38:00Z")).toBe("2026-05-18T13:38:00.000Z");
    expect(parseEmailDate("2026-05-18T13:38:00-04:00")).toBe("2026-05-18T17:38:00.000Z");
  });
  it("returns null for junk rather than guessing", () => {
    expect(parseEmailDate("sometime last week")).toBeNull();
    expect(parseEmailDate("")).toBeNull();
  });
});
