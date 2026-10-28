import type { FetchLike } from "../../lib/gitea";

/**
 * A Gitea pull request whose draft state is the title prefix, exactly as the
 * forge models it. PATCH replaces the title, and a merge closes the request, so
 * a test can prove that a later update neither drops nor invents draft state.
 */

export interface GiteaCall {
  method: string;
  url: string;
  body?: string;
}

export interface FakeGiteaPull {
  fetch: FetchLike;
  calls: GiteaCall[];
  /** The title the next GET reports. */
  title(): string;
  merged(): boolean;
}

export function fakeGiteaPull(calls: GiteaCall[] = [], number = 3): FakeGiteaPull {
  let title = "";
  let state = "open";
  let merged = false;
  const url = `http://gitea.test/acme/fixture/pulls/${number}`;

  const fetch: FetchLike = async (input, init) => {
    const requestUrl = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url: requestUrl, ...(body === undefined ? {} : { body }) });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const document = () => ({ number, html_url: url, title, state, merged });

    if (method === "POST" && requestUrl.endsWith("/api/v1/repos/acme/fixture/pulls")) {
      const patch = JSON.parse(body ?? "{}") as { title?: unknown };
      title = typeof patch.title === "string" ? patch.title : "";
      state = "open";
      merged = false;
      return json(document(), 201);
    }
    if (method === "GET" && requestUrl.endsWith(`/api/v1/repos/acme/fixture/pulls/${number}`)) {
      return json(document());
    }
    if (method === "PATCH" && requestUrl.endsWith(`/api/v1/repos/acme/fixture/pulls/${number}`)) {
      const patch = JSON.parse(body ?? "{}") as { title?: unknown };
      if (typeof patch.title === "string") title = patch.title;
      return json({});
    }
    if (
      method === "POST" &&
      requestUrl.endsWith(`/api/v1/repos/acme/fixture/pulls/${number}/merge`)
    ) {
      merged = true;
      state = "closed";
      return new Response("", { status: 200 });
    }
    return json({ message: `unexpected ${method} ${requestUrl}` }, 500);
  };

  return { fetch, calls, title: () => title, merged: () => merged };
}
