import { expect, test } from "bun:test";
import {
  MAX_ROUTE,
  MAX_SELECTOR,
  MAX_URL,
  MAX_VIEWPORT,
  pageContext,
  truncate,
} from "./feedback-capture.ts";

/** The server's own limits: a raised client constant fails here. */
const SERVER_CONTEXT_FIELD = 2000;
const SERVER_VIEWPORT = 500;

test("every page field is bounded to the limit the server enforces", () => {
  const long = "x".repeat(4000);
  const context = pageContext(
    { pathname: `/${long}`, href: `http://forge.test/${long}`, viewport: long },
    long,
  );

  expect(context.route.length).toBe(MAX_ROUTE);
  expect(context.url.length).toBe(MAX_URL);
  expect(context.selector.length).toBe(MAX_SELECTOR);
  expect(context.viewport.length).toBe(MAX_VIEWPORT);

  expect(context.route.length).toBeLessThanOrEqual(SERVER_CONTEXT_FIELD);
  expect(context.url.length).toBeLessThanOrEqual(SERVER_CONTEXT_FIELD);
  expect(context.selector.length).toBeLessThanOrEqual(SERVER_CONTEXT_FIELD);
  expect(context.viewport.length).toBeLessThanOrEqual(SERVER_VIEWPORT);
  expect(context.route.endsWith("…")).toBe(true);
  expect(context.viewport.endsWith("…")).toBe(true);
});

test("a field at its bound is carried whole", () => {
  const selector = "s".repeat(MAX_SELECTOR);
  const context = pageContext(
    { pathname: "/board", href: "http://forge.test/board", viewport: "1440x900 @1x" },
    selector,
  );

  expect(context).toEqual({
    route: "/board",
    url: "http://forge.test/board",
    selector,
    viewport: "1440x900 @1x",
  });
  expect(truncate("  a \t b  ", 20)).toBe("a b");
});
