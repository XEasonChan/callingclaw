import { test, expect, describe, mock, beforeEach } from "bun:test";
import { GoogleCalendarClient } from "../src/mcp_client/google_cal";

describe("GoogleCalendarClient auth error detection", () => {
  let client: GoogleCalendarClient;

  beforeEach(() => {
    client = new GoogleCalendarClient();
  });

  test("authError is null initially", () => {
    expect(client.authError).toBeNull();
    expect(client.connected).toBe(false);
  });

  test("connect() sets authError on failure with bad credentials", async () => {
    // Force bad credentials so refresh will fail
    (client as any).clientId = "bad-id";
    (client as any).clientSecret = "bad-secret";
    (client as any).refreshToken = "bad-token";
    await client.connect();
    expect(client.connected).toBe(false);
    expect(client.authError).toBeTruthy();
  });

  test("onAuthError callback fires on runtime auth failure", async () => {
    let callbackError: string | null = null;
    client.onAuthError = (err) => { callbackError = err; };

    // Force the client to think it's connected with an expired token
    (client as any)._connected = true;
    (client as any).accessToken = "expired-token";
    (client as any).tokenExpiry = 0; // Already expired

    // listUpcomingEvents calls getToken() internally which will try to refresh
    // With no credentials, refreshAccessToken will fail
    const events = await client.listUpcomingEvents();

    // Should return empty array (error swallowed at method level)
    expect(events).toEqual([]);
    // But the auth state should be updated
    expect(client.connected).toBe(false);
    expect(client.authError).toBeTruthy();
    expect(callbackError).toBeTruthy();
  });

  test("createEvent returns specific auth error message when disconnected with authError", async () => {
    (client as any)._connected = false;
    (client as any)._authError = "Token refresh failed (401): invalid_grant";

    const result = await client.createEvent({
      summary: "Test",
      start: new Date().toISOString(),
      end: new Date().toISOString(),
    });

    expect(result).toContain("Calendar auth error");
    expect(result).toContain("invalid_grant");
  });

  test("createEvent returns generic message when disconnected without authError", async () => {
    (client as any)._connected = false;
    (client as any)._authError = null;

    const result = await client.createEvent({
      summary: "Test",
      start: new Date().toISOString(),
      end: new Date().toISOString(),
    });

    expect(result).toBe("Calendar not connected");
  });
});
