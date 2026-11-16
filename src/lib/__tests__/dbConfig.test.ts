import { afterEach, describe, expect, it } from "vitest";
import { databaseUrl, withoutLibpqOnlyParams } from "../dbConfig";

describe("withoutLibpqOnlyParams", () => {
  it("drops channel_binding from a Neon connection string and keeps sslmode", () => {
    const neon =
      "postgresql://user:pw@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    expect(withoutLibpqOnlyParams(neon)).toBe(
      "postgresql://user:pw@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
    );
  });

  it("drops gssencmode", () => {
    expect(withoutLibpqOnlyParams("postgres://h/db?gssencmode=disable")).toBe("postgres://h/db");
  });

  it("returns other strings unchanged, byte for byte", () => {
    const supabase = "postgres://postgres.abc:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    expect(withoutLibpqOnlyParams(supabase)).toBe(supabase);
    expect(withoutLibpqOnlyParams("not a url")).toBe("not a url");
  });
});

describe("databaseUrl", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("cleans the configured DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://u:p@host/db?sslmode=require&channel_binding=require";
    expect(databaseUrl()).toBe("postgres://u:p@host/db?sslmode=require");
  });

  it("is undefined when nothing is set", () => {
    delete process.env.DATABASE_URL;
    delete process.env.SUPABASE_DB_URL;
    expect(databaseUrl()).toBeUndefined();
  });
});
