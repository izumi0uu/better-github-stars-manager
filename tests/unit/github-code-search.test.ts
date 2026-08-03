import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { authStore } from '../../src/auth/auth-store';
import {
  MAX_TOOL_RESULT_BYTES,
  okToolResult,
  serializedToolResultByteLength,
  ToolOutputTooLargeError,
} from '../../src/agent-harness';
import {
  GithubCodeSearchError,
  listRepositoryFiles,
  readRepositoryFile,
  searchIndexedRepositoryCode,
} from '../../src/api/github-code-search';
import {
  createRepositoryCodeRefAuthority,
  createRepositoryCodeSearchTool,
  createRepositoryCodeTools,
} from '../../src/bgsm-agent/repository-code-search-tool';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function repoResponse(fullName: string, overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    full_name: fullName,
    private: false,
    archived: false,
    visibility: 'public',
    ...overrides,
  });
}

function searchResponse(fullName: string, items: unknown[]): Response {
  return jsonResponse({
    total_count: items.length,
    incomplete_results: false,
    items: items.map((item) => {
      const record = item as Record<string, unknown>;
      const path = typeof record.path === 'string' ? record.path : 'src/index.ts';
      return {
        repository: { full_name: fullName },
        path,
        sha: SHA,
        html_url: `https://github.com/${fullName}/blob/${COMMIT}/${path}`,
        ...record,
      };
    }),
  });
}

function blobResponse(source: string, sha = SHA): Response {
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return jsonResponse({
    sha,
    encoding: 'base64',
    size: bytes.byteLength,
    content: btoa(binary),
  });
}

function commitResponse(sha = COMMIT): Response {
  return jsonResponse({ object: { type: 'commit', sha } });
}

function contentsFileResponse(source: string, path: string, sha = SHA): Response {
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return jsonResponse({
    type: 'file',
    name: path.split('/').at(-1),
    path,
    sha,
    encoding: 'base64',
    size: bytes.byteLength,
    content: btoa(binary),
  });
}

function errorCode(code: GithubCodeSearchError['code']): (error: unknown) => boolean {
  return (error) => error instanceof GithubCodeSearchError && error.code === code;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('repository list and read', () => {
  it('resolves the default branch once and reuses its immutable ref for directory pagination', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const requests: URL[] = [];
    const directory = [
      { type: 'file', name: 'z.ts', path: 'src/z.ts', sha: SHA, size: 12 },
      { type: 'dir', name: 'components', path: 'src/components', sha: COMMIT, size: 0 },
    ];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === '/repos/octo/one') {
        return repoResponse('octo/one', { default_branch: 'feature/x' });
      }
      if (url.pathname === '/repos/octo/one/git/ref/heads/feature/x') return commitResponse();
      if (url.pathname === '/repos/octo/one/contents/src') return jsonResponse(directory);
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;

    const first = await listRepositoryFiles({
      repositories: ['octo/one', 'octo/two', 'octo/three', 'octo/four', 'octo/five', 'octo/six'],
      repository: 'OCTO/ONE',
      path: 'src',
      limit: 1,
    }, { fetchImpl });
    assert.equal(first.repository, 'octo/one');
    assert.equal(first.defaultBranch, 'feature/x');
    assert.equal(first.ref, COMMIT);
    assert.equal(first.cursor, '0');
    assert.equal(first.nextCursor, '1');
    assert.equal(first.totalEntries, 2);
    assert.deepEqual(first.entries, [{
      name: 'components',
      path: 'src/components',
      type: 'directory',
      size: 0,
      sha: COMMIT,
      untrusted: true,
    }]);

    const second = await listRepositoryFiles({
      repositories: ['octo/one', 'octo/two', 'octo/three', 'octo/four', 'octo/five', 'octo/six'],
      repository: 'octo/one',
      path: 'src',
      ref: first.ref,
      cursor: first.nextCursor!,
      limit: 1,
    }, { fetchImpl });
    assert.equal(second.ref, COMMIT);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(second.entries.map((entry) => entry.path), ['src/z.ts']);
    assert.equal(requests.filter((url) => url.pathname.endsWith('/git/ref/heads/feature/x')).length, 1);
    assert.ok(requests.every((url) => url.origin === 'https://api.github.com'));
    assert.ok(
      requests
        .filter((url) => url.pathname.endsWith('/contents/src'))
        .every((url) => url.searchParams.get('ref') === COMMIT),
    );
    await assert.rejects(
      () => listRepositoryFiles({
        repositories: ['octo/one'],
        repository: 'octo/one',
        path: 'src',
        ref: COMMIT,
        cursor: '999',
      }, { fetchImpl }),
      errorCode('invalid_cursor'),
    );
  });

  it('reads a bounded line range at the supplied commit ref', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const requests: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/repos/octo/one/contents/src/index.ts') {
        return contentsFileResponse('one\ntwo\nthree\nfour', 'src/index.ts');
      }
      if (url.pathname === '/repos/octo/one/contents/src/empty.ts') {
        return contentsFileResponse('', 'src/empty.ts');
      }
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;

    const result = await readRepositoryFile({
      repositories: ['octo/one'],
      repository: 'octo/one',
      path: 'src/index.ts',
      ref: COMMIT,
      lineStart: 2,
      lineEnd: 3,
    }, { fetchImpl });

    assert.deepEqual(result, {
      repository: 'octo/one',
      path: 'src/index.ts',
      ref: COMMIT,
      blobSha: SHA,
      lineStart: 2,
      lineEnd: 3,
      totalLines: 4,
      content: 'two\nthree',
      nextLineStart: 4,
      contentTruncated: false,
      untrusted: true,
    });
    assert.ok(requests.every((url) => url.origin === 'https://api.github.com'));
    assert.equal(requests.at(-1)?.searchParams.get('ref'), COMMIT);
    const empty = await readRepositoryFile({
      repositories: ['octo/one'],
      repository: 'octo/one',
      path: 'src/empty.ts',
      ref: COMMIT,
    }, { fetchImpl });
    assert.equal(empty.totalLines, 1);
    assert.equal(empty.lineStart, 1);
    assert.equal(empty.lineEnd, 1);
    assert.equal(empty.content, '');
    assert.equal(empty.nextLineStart, null);
    assert.equal(empty.contentTruncated, false);
    await assert.rejects(
      () => readRepositoryFile({
        repositories: ['octo/one'],
        repository: 'octo/one',
        path: 'src/index.ts',
        ref: COMMIT,
        lineStart: 5,
        lineEnd: 5,
      }, { fetchImpl }),
      errorCode('invalid_line_range'),
    );
  });

  it('paginates a realistic thousand-entry directory response above 512 KiB', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const entries = Array.from({ length: 1_000 }, (_, index) => {
      const name = `${String(index).padStart(4, '0')}-${'x'.repeat(180)}.ts`;
      const apiUrl = `https://api.github.com/repos/octo/one/contents/${name}?ref=${COMMIT}`;
      return {
        type: 'file',
        name,
        path: name,
        sha: index.toString(16).padStart(40, '0'),
        size: 100,
        url: apiUrl,
        html_url: `https://github.com/octo/one/blob/${COMMIT}/${name}`,
        git_url: `https://api.github.com/repos/octo/one/git/blobs/${SHA}`,
        download_url: `https://raw.githubusercontent.com/octo/one/${COMMIT}/${name}`,
        _links: { self: apiUrl, git: apiUrl, html: apiUrl },
      };
    });
    assert.ok(new TextEncoder().encode(JSON.stringify(entries)).byteLength > 512 * 1024);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') {
        return repoResponse('octo/one', { default_branch: 'main' });
      }
      if (url.pathname.endsWith('/git/ref/heads/main')) return commitResponse();
      if (url.pathname.endsWith('/contents')) return jsonResponse(entries);
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;

    const first = await listRepositoryFiles({
      repositories: ['octo/one'],
      repository: 'octo/one',
      limit: 25,
    }, { fetchImpl });
    assert.equal(first.status, 'partial');
    assert.equal(first.totalEntries, 1_000);
    assert.equal(first.entries.length, 25);
    assert.equal(first.nextCursor, '25');
    assert.ok(first.warnings.includes('directory_limit_reached'));

    const second = await listRepositoryFiles({
      repositories: ['octo/one'],
      repository: 'octo/one',
      ref: first.ref,
      cursor: first.nextCursor!,
      limit: 25,
    }, { fetchImpl });
    assert.equal(second.entries.length, 25);
    assert.equal(second.nextCursor, '50');
  });

  it('rejects repositories outside scope and invalid paths, refs, cursors, and line ranges before fetching', async () => {
    const fetchMock = vi.fn();
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await assert.rejects(
      () => listRepositoryFiles({
        repositories: ['octo/one'],
        repository: 'octo/two',
      }, { fetchImpl }),
      errorCode('invalid_repository'),
    );
    await assert.rejects(
      () => listRepositoryFiles({
        repositories: ['octo/one'],
        repository: 'octo/one',
        path: '../secret',
      }, { fetchImpl }),
      errorCode('invalid_path'),
    );
    await assert.rejects(
      () => listRepositoryFiles({
        repositories: ['octo/one'],
        repository: 'octo/one',
        cursor: '1',
      }, { fetchImpl }),
      errorCode('invalid_ref'),
    );
    await assert.rejects(
      () => readRepositoryFile({
        repositories: ['octo/one'],
        repository: 'octo/one',
        path: 'src/index.ts',
        ref: 'main',
      }, { fetchImpl }),
      errorCode('invalid_ref'),
    );
    await assert.rejects(
      () => readRepositoryFile({
        repositories: ['octo/one'],
        repository: 'octo/one',
        path: 'src/index.ts',
        ref: COMMIT,
        lineStart: 1,
        lineEnd: 201,
      }, { fetchImpl }),
      errorCode('invalid_line_range'),
    );
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('rejects binary and oversized file content without exposing upstream bodies', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    let oversized = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (oversized) {
        return new Response(null, { headers: { 'content-length': String(512 * 1024 + 1) } });
      }
      return jsonResponse({
        type: 'file',
        name: 'data.bin',
        path: 'data.bin',
        sha: SHA,
        encoding: 'base64',
        size: 3,
        content: 'AQID',
        secret: 'must-not-leak',
      });
    }) as typeof fetch;

    await assert.rejects(
      () => readRepositoryFile({
        repositories: ['octo/one'],
        repository: 'octo/one',
        path: 'data.bin',
        ref: COMMIT,
      }, { fetchImpl }),
      errorCode('content_not_text'),
    );
    oversized = true;
    await assert.rejects(
      () => readRepositoryFile({
        repositories: ['octo/one'],
        repository: 'octo/one',
        path: 'data.bin',
        ref: COMMIT,
      }, { fetchImpl }),
      errorCode('content_too_large'),
    );
  });

  it('exposes strict list/search/read tools and fits list/read data to each result allowance', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    let fileSource = Array.from({ length: 200 }, () => 'x'.repeat(40)).join('\n');
    const entries = Array.from({ length: 20 }, (_, index) => ({
      type: 'file',
      name: `${String(index).padStart(2, '0')}-${'x'.repeat(32)}.ts`,
      path: `${String(index).padStart(2, '0')}-${'x'.repeat(32)}.ts`,
      sha: index.toString(16).padStart(40, '0'),
      size: 100,
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') {
        return repoResponse('octo/one', { default_branch: 'main' });
      }
      if (url.pathname.endsWith('/git/ref/heads/main')) return commitResponse();
      if (url.pathname.endsWith('/contents')) return jsonResponse(entries);
      if (url.pathname.endsWith('/contents/src/index.ts')) {
        return contentsFileResponse(fileSource, 'src/index.ts');
      }
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    const tools = createRepositoryCodeTools(['octo/one']);
    assert.deepEqual(tools.map((tool) => tool.name), [
      'list_repository_files',
      'search_repository_code',
      'read_repository_file',
    ]);
    const list = tools[0];
    const search = tools[1];
    const read = tools[2];
    assert.deepEqual(
      (list.parameters?.properties as Record<string, unknown>).repository,
      { type: 'string', enum: ['octo/one'] },
    );
    assert.deepEqual(
      (read.parameters?.properties as Record<string, unknown>).repository,
      { type: 'string', enum: ['octo/one'] },
    );
    assert.deepEqual(
      (search.parameters?.properties as Record<string, unknown>).repository,
      { type: 'string', enum: ['octo/one'] },
    );
    const largeScopeTools = createRepositoryCodeTools([
      'octo/one',
      'octo/two',
      'octo/three',
      'octo/four',
      'octo/five',
      'octo/six',
    ]);
    const largeScopeList = largeScopeTools[0];
    const largeScopeSearch = largeScopeTools[1];
    assert.deepEqual(
      (largeScopeList.parameters?.properties as Record<string, unknown>).repository,
      { type: 'string' },
    );
    assert.deepEqual(largeScopeSearch.parameters?.required, ['query', 'repository']);
    assert.throws(
      () => largeScopeSearch.validate?.({ query: 'needle' }),
      /missing fields/i,
    );
    assert.deepEqual(
      largeScopeSearch.validate?.({ query: 'needle', repository: 'OCTO/ONE' }),
      { query: 'needle', repository: 'octo/one' },
    );
    assert.deepEqual(list.validate?.({ repository: 'OCTO/ONE', limit: 20 }), {
      repository: 'octo/one',
      limit: 20,
    });
    assert.throws(
      () => list.validate?.({ repository: 'octo/two' }),
      /outside the frozen scope/i,
    );
    assert.throws(
      () => read.validate?.({ repository: 'octo/one', path: 'a.ts', ref: COMMIT, lineStart: 1, lineEnd: 201 }),
      /limited to 200 lines/i,
    );
    assert.throws(
      () => list.validate?.({ repository: 'octo/one', path: 'src' }),
      /subdirectory listing requires a trusted commit ref/i,
    );

    await assert.rejects(
      () => read.execute(
        read.validate?.({ repository: 'octo/one', path: 'src/index.ts', ref: COMMIT }),
        { sessionId: 's-read-untrusted', callId: 'c-read-untrusted' },
      ),
      /list the repository root or run code search again/i,
    );
    await assert.rejects(
      () => list.execute(
        list.validate?.({ repository: 'octo/one', ref: 'b'.repeat(40) }),
        { sessionId: 's-list-untrusted', callId: 'c-list-untrusted' },
      ),
      /list the repository root or run code search again/i,
    );

    const listArgs = list.validate?.({ repository: 'octo/one', limit: 20 });
    const fullListing = await list.execute(listArgs, {
      sessionId: 's-list-full',
      callId: 'c-list-full',
    }) as Awaited<ReturnType<typeof listRepositoryFiles>>;
    const zeroEntryAllowance = serializedToolResultByteLength(okToolResult({
      ...fullListing,
      status: 'partial',
      warnings: ['result_limit_reached'],
      entries: [],
      nextCursor: '0',
    }));
    await assert.rejects(
      () => list.execute(listArgs, {
        sessionId: 's-list-too-small',
        callId: 'c-list-too-small',
        resultAllowance: {
          maxSerializedBytes: zeroEntryAllowance,
          contextRemainingTokens: 10_000,
          memoryRemainingBytes: zeroEntryAllowance,
        },
      }),
      (error) => error instanceof ToolOutputTooLargeError && /single directory entry/i.test(error.message),
    );

    const listAllowance = 700;
    const listed = await list.execute(
      listArgs,
      {
        sessionId: 's-list',
        callId: 'c-list',
        resultAllowance: {
          maxSerializedBytes: listAllowance,
          contextRemainingTokens: 10_000,
          memoryRemainingBytes: listAllowance,
        },
      },
    ) as Awaited<ReturnType<typeof listRepositoryFiles>>;
    assert.equal(listed.status, 'partial');
    assert.ok(listed.warnings.includes('result_limit_reached'));
    assert.ok(listed.entries.length < entries.length);
    assert.ok(serializedToolResultByteLength(okToolResult(listed)) <= listAllowance);

    const readAllowance = 500;
    const file = await read.execute(
      read.validate?.({ repository: 'octo/one', path: 'src/index.ts', ref: COMMIT }),
      {
        sessionId: 's-read',
        callId: 'c-read',
        resultAllowance: {
          maxSerializedBytes: readAllowance,
          contextRemainingTokens: 10_000,
          memoryRemainingBytes: readAllowance,
        },
      },
    ) as Awaited<ReturnType<typeof readRepositoryFile>>;
    assert.equal(file.contentTruncated, true);
    assert.ok(file.lineEnd < 200);
    assert.equal(file.nextLineStart, file.lineEnd + 1);
    assert.equal(file.content.split('\n').length, file.lineEnd - file.lineStart + 1);
    assert.ok(serializedToolResultByteLength(okToolResult(file)) <= readAllowance);

    fileSource = 'x'.repeat(2_000);
    await assert.rejects(
      () => read.execute(
        read.validate?.({ repository: 'octo/one', path: 'src/index.ts', ref: COMMIT }),
        {
          sessionId: 's-read-long-line',
          callId: 'c-read-long-line',
          resultAllowance: {
            maxSerializedBytes: readAllowance,
            contextRemainingTokens: 10_000,
            memoryRemainingBytes: readAllowance,
          },
        },
      ),
      (error) => error instanceof ToolOutputTooLargeError && /first requested line/i.test(error.message),
    );
  });

  it('searches one selected repository from a large frozen scope and trusts its returned ref', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') {
        assert.ok(url.searchParams.get('q')?.endsWith('repo:octo/one'));
        return searchResponse('octo/one', [{ path: 'src/index.ts' }]);
      }
      if (url.pathname.includes('/git/blobs/')) return blobResponse('const needle = true;');
      if (url.pathname === '/repos/octo/one/contents/src/index.ts') {
        return contentsFileResponse('const needle = true;', 'src/index.ts');
      }
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    const authority = createRepositoryCodeRefAuthority();
    const tools = createRepositoryCodeTools([
      'octo/one',
      'octo/two',
      'octo/three',
      'octo/four',
      'octo/five',
      'octo/six',
    ], authority);
    const search = tools[1];
    const searched = await search.execute(
      search.validate?.({ query: 'needle', repository: 'octo/one' }),
      { sessionId: 's-large-search', callId: 'c-large-search' },
    ) as Awaited<ReturnType<typeof searchIndexedRepositoryCode>>;
    assert.equal(searched.searchedRepositoryCount, 1);
    assert.equal(searched.matches[0]?.ref, COMMIT);

    const continuedRead = createRepositoryCodeTools([
      'octo/one',
      'octo/two',
      'octo/three',
      'octo/four',
      'octo/five',
      'octo/six',
    ], authority)[2];
    const file = await continuedRead.execute(
      continuedRead.validate?.({
        repository: 'octo/one',
        path: 'src/index.ts',
        ref: searched.matches[0]!.ref,
      }),
      { sessionId: 's-large-read', callId: 'c-large-read' },
    ) as Awaited<ReturnType<typeof readRepositoryFile>>;
    assert.equal(file.content, 'const needle = true;');
  });

  it('rejects invalid direct search execution without consuming the valid attempt', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') return searchResponse('octo/one', [{ path: 'src/index.ts' }]);
      if (url.pathname.includes('/git/blobs/')) return blobResponse('const needle = true;');
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const tool = createRepositoryCodeSearchTool(['octo/one']);

    await assert.rejects(
      () => tool.execute(
        { query: 'needle OR secret' },
        { sessionId: 's-invalid-direct', callId: 'c-invalid-direct' },
      ),
      errorCode('invalid_query'),
    );
    assert.throws(
      () => tool.validate?.({ query: 'repo:octo/one' }),
      /bounded literal without operators or qualifiers/i,
    );

    const args = tool.validate?.({ query: 'needle' });
    assert.ok(args);
    const result = await tool.execute(args, {
      sessionId: 's-valid-after-invalid',
      callId: 'c-valid-after-invalid',
    });
    assert.equal(result.matches.length, 1);
  });
});

describe('searchIndexedRepositoryCode', () => {
  it('validates the entire public non-archived scope before searching', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer github_pat_test');
      return requests.length === 1
        ? repoResponse('octo/one')
        : repoResponse('octo/two', { archived: true });
    }) as typeof fetch;

    await assert.rejects(
      () => searchIndexedRepositoryCode(
        { repositories: ['octo/one', 'octo/two'], query: 'needle' },
        { fetchImpl },
      ),
      errorCode('scope_ineligible'),
    );

    assert.deepEqual(requests, [
      'https://api.github.com/repos/octo/one',
      'https://api.github.com/repos/octo/two',
    ]);
  });

  it('uses one fixed-origin search per repository and returns reverified literal matches', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/repos/octo/two') return repoResponse('octo/two');
      if (url.pathname === '/search/code') {
        const repository = url.searchParams.get('q')?.endsWith('repo:octo/one')
          ? 'octo/one'
          : 'octo/two';
        return searchResponse(repository, [{
          path: repository === 'octo/one' ? 'src/a.ts' : 'src/b.ts',
        }]);
      }
      if (url.pathname.includes('/git/blobs/')) {
        return blobResponse(url.pathname.includes('/octo/one/')
          ? 'first\nconst needle = true;\nlast'
          : 'no literal in this indexed candidate');
      }
      throw new Error('unexpected request');
    }) as typeof fetch;

    const result = await searchIndexedRepositoryCode(
      { repositories: ['octo/one', 'octo/two'], query: 'needle' },
      { fetchImpl },
    );

    assert.equal(requests.filter(({ url }) => url.pathname === '/search/code').length, 2);
    assert.ok(requests.every(({ url }) => url.origin === 'https://api.github.com'));
    assert.equal(result.status, 'complete');
    assert.equal(result.untrusted, true);
    assert.equal(result.searchedRepositoryCount, 2);
    assert.deepEqual(result.searchedRepositories, ['octo/one', 'octo/two']);
    assert.deepEqual(result.warnings, ['candidate_without_literal_match']);
    assert.deepEqual(result.matches, [{
      repository: 'octo/one',
      path: 'src/a.ts',
      blobSha: SHA,
      ref: COMMIT,
      lineStart: 2,
      lineEnd: 2,
      snippet: 'const needle = true;',
      apiUrl: `https://api.github.com/repos/octo/one/git/blobs/${SHA}`,
      githubUrl: `https://github.com/octo/one/blob/${COMMIT}/src/a.ts#L2`,
      untrusted: true,
    }]);
    assert.equal('query' in result, false);
  });

  it('refuses to discard the only verified match to fit the result allowance', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') return searchResponse('octo/one', [{ path: 'src/a.ts' }]);
      return blobResponse(`${'x'.repeat(300)}needle${'y'.repeat(300)}`);
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const tool = createRepositoryCodeSearchTool(['octo/one']);
    const args = tool.validate?.({ query: 'needle' });
    assert.ok(args);
    const maxSerializedBytes = 300;
    await assert.rejects(
      () => tool.execute(args, {
        sessionId: 's-code-allowance',
        callId: 'c-code-allowance',
        resultAllowance: {
          maxSerializedBytes,
          contextRemainingTokens: 10_000,
          memoryRemainingBytes: maxSerializedBytes,
        },
      }),
      (error) => error instanceof ToolOutputTooLargeError && /single verified match/i.test(error.message),
    );
  });

  it('keeps one verified match and marks a multi-match allowance reduction partial', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const firstSha = 'a'.repeat(40);
    const secondSha = 'b'.repeat(40);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') {
        return searchResponse('octo/one', [
          { path: 'src/a.ts', sha: firstSha },
          { path: 'src/b.ts', sha: secondSha },
        ]);
      }
      if (url.pathname.endsWith(firstSha)) return blobResponse('const needleA = true;', firstSha);
      if (url.pathname.endsWith(secondSha)) return blobResponse('const needleB = true;', secondSha);
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    const fullTool = createRepositoryCodeSearchTool(['octo/one']);
    const fullArgs = fullTool.validate?.({ query: 'needle' });
    assert.ok(fullArgs);
    const full = await fullTool.execute(
      fullArgs,
      { sessionId: 's-code-full', callId: 'c-code-full' },
    );
    assert.equal(full.matches.length, 2);
    const oneMatchBudget = serializedToolResultByteLength(okToolResult({
      ...full,
      status: 'partial',
      warnings: [...full.warnings, 'match_limit_reached'],
      matches: full.matches.slice(0, 1),
    }));

    const limitedTool = createRepositoryCodeSearchTool(['octo/one']);
    const limitedArgs = limitedTool.validate?.({ query: 'needle' });
    assert.ok(limitedArgs);
    const limited = await limitedTool.execute(
      limitedArgs,
      {
        sessionId: 's-code-limited',
        callId: 'c-code-limited',
        resultAllowance: {
          maxSerializedBytes: oneMatchBudget,
          contextRemainingTokens: 10_000,
          memoryRemainingBytes: oneMatchBudget,
        },
      },
    );
    assert.equal(limited.status, 'partial');
    assert.equal(limited.matches.length, 1);
    assert.ok(limited.warnings.includes('match_limit_reached'));
    assert.ok(serializedToolResultByteLength(okToolResult(limited)) <= oneMatchBudget);
  });

  it('preserves a genuine empty indexed result without inventing a partial status', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') return searchResponse('octo/one', []);
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    const tool = createRepositoryCodeSearchTool(['octo/one']);
    const args = tool.validate?.({ query: 'needle' });
    assert.ok(args);
    const result = await tool.execute(
      args,
      { sessionId: 's-code-empty', callId: 'c-code-empty' },
    );

    assert.equal(result.status, 'no_indexed_matches');
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.warnings, []);
  });

  it('verifies indexed literal matches without case-sensitive false negatives', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') return searchResponse('octo/one', [{ path: 'src/index.ts' }]);
      if (url.pathname.includes('/git/blobs/')) return blobResponse('export function indexedSearch() {}');
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;

    const result = await searchIndexedRepositoryCode(
      { repositories: ['octo/one'], query: 'INDEXEDSEARCH' },
      { fetchImpl },
    );

    assert.equal(result.status, 'complete');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.snippet, 'export function indexedSearch() {}');
  });

  it('rejects query operators, qualifiers, controls, and out-of-range scalar counts without fetching', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchMock = vi.fn();
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const invalidQueries = [
      'repo:other/project',
      'needle OR secret',
      'path:src needle',
      'line\nbreak',
      'line\u2028break',
      '\ud800',
      '"needle"',
      'x'.repeat(129),
      '',
    ];

    for (const query of invalidQueries) {
      await assert.rejects(
        () => searchIndexedRepositoryCode({ repositories: ['octo/one'], query }, { fetchImpl }),
        errorCode('invalid_query'),
      );
    }
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('rejects malformed, duplicate, and oversized repository scopes', async () => {
    const fetchMock = vi.fn();
    const fetchImpl = fetchMock as unknown as typeof fetch;
    for (const repositories of [
      [],
      ['octo/one', 'OCTO/ONE'],
      ['../one'],
      ['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6'],
    ]) {
      await assert.rejects(
        () => searchIndexedRepositoryCode({ repositories, query: 'needle' }, { fetchImpl }),
        errorCode('invalid_scope'),
      );
    }
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('marks excess indexed candidates partial and hydrates at most eight blobs', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    let blobRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') {
        const items = Array.from({ length: 9 }, (_, index) => ({
          repository: { full_name: 'octo/one' },
          path: `src/${index}.ts`,
          sha: index.toString(16).padStart(40, '0'),
          html_url: `https://github.com/octo/one/blob/${COMMIT}/src/${index}.ts`,
        }));
        return jsonResponse({ total_count: 9, items });
      }
      blobRequests += 1;
      const sha = url.pathname.split('/').at(-1)!;
      return blobResponse('needle', sha);
    }) as typeof fetch;

    const result = await searchIndexedRepositoryCode(
      { repositories: ['octo/one'], query: 'needle' },
      { fetchImpl },
    );

    assert.equal(blobRequests, 8);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.warnings, ['candidate_limit_reached']);
    assert.equal(result.matches.length, 8);
  });

  it('skips indexed candidates whose paths cannot be consumed by list/read tools', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const oversizedUtf8Path = `${'界'.repeat(400)}.ts`;
    let blobRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') {
        return searchResponse('octo/one', [
          { path: 'src\\invalid.ts' },
          { path: oversizedUtf8Path },
          { path: 'src/valid.ts' },
        ]);
      }
      if (url.pathname.includes('/git/blobs/')) {
        blobRequests += 1;
        return blobResponse('const needle = true;');
      }
      throw new Error(`unexpected request: ${url.href}`);
    }) as typeof fetch;

    const result = await searchIndexedRepositoryCode(
      { repositories: ['octo/one'], query: 'needle' },
      { fetchImpl },
    );

    assert.equal(blobRequests, 1);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.warnings, ['candidate_invalid']);
    assert.deepEqual(result.matches.map((match) => match.path), ['src/valid.ts']);
  });

  it('bounds the complete success envelope with maximum repository names and paths', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const repository = `${`o${'a'.repeat(38)}`}/${`r${'b'.repeat(99)}`}`;
    const paths = Array.from(
      { length: 8 },
      (_, index) => `src/${'p'.repeat(1_019)}${index}`,
    );
    assert.equal(repository.length, 140);
    assert.ok(paths.every((path) => path.length === 1_024));

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === `/repos/${repository}`) return repoResponse(repository);
      if (url.pathname === '/search/code') {
        return searchResponse(repository, paths.map((path) => ({ path })));
      }
      return blobResponse(`${'x'.repeat(600)}needle${'y'.repeat(600)}`);
    }) as typeof fetch;

    const result = await searchIndexedRepositoryCode(
      { repositories: [repository], query: 'needle' },
      { fetchImpl },
    );

    assert.equal(result.status, 'partial');
    assert.ok(result.matches.length > 0 && result.matches.length < paths.length);
    assert.ok(result.warnings.includes('match_limit_reached'));
    assert.ok(
      serializedToolResultByteLength(okToolResult(result)) <= MAX_TOOL_RESULT_BYTES,
    );
  });

  it('bounds and rejects binary blob content without leaking upstream bodies', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') return searchResponse('octo/one', [{}]);
      return jsonResponse({
        sha: SHA,
        encoding: 'base64',
        size: 3,
        content: 'AQID',
        secret: 'must-not-leak',
      });
    }) as typeof fetch;

    const result = await searchIndexedRepositoryCode(
      { repositories: ['octo/one'], query: 'needle' },
      { fetchImpl },
    );

    assert.equal(result.status, 'partial');
    assert.deepEqual(result.warnings, ['candidate_not_text']);
    assert.deepEqual(result.matches, []);
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  });

  it('enforces canonical base64 and the 512-byte snippet ceiling', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    let nonCanonical = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') return searchResponse('octo/one', [{}]);
      if (nonCanonical) {
        return jsonResponse({ sha: SHA, encoding: 'base64', size: 1, content: 'YR==' });
      }
      return blobResponse(`${'\ud83d\ude80'.repeat(200)}needle${'\ud83d\ude80'.repeat(200)}`);
    }) as typeof fetch;

    const bounded = await searchIndexedRepositoryCode(
      { repositories: ['octo/one'], query: 'needle' },
      { fetchImpl },
    );
    assert.equal(bounded.matches.length, 1);
    assert.ok(new TextEncoder().encode(bounded.matches[0].snippet).byteLength <= 512);
    assert.ok(bounded.matches[0].snippet.includes('needle'));

    nonCanonical = true;
    const rejected = await searchIndexedRepositoryCode(
      { repositories: ['octo/one'], query: 'needle' },
      { fetchImpl },
    );
    assert.deepEqual(rejected.warnings, ['candidate_not_text']);
  });

  it('returns safe partial warnings for failed searches and rejects expired deadlines', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/repos/')) return repoResponse('octo/one');
      return jsonResponse({ message: 'sensitive upstream failure' }, 500);
    }) as typeof fetch;

    const partial = await searchIndexedRepositoryCode(
      { repositories: ['octo/one'], query: 'needle' },
      { fetchImpl },
    );
    assert.deepEqual(partial.warnings, ['search_unavailable']);
    assert.equal(JSON.stringify(partial).includes('sensitive'), false);

    await assert.rejects(
      () => searchIndexedRepositoryCode(
        { repositories: ['octo/one'], query: 'needle' },
        { fetchImpl, deadline: Date.now() - 1 },
      ),
      errorCode('deadline_exceeded'),
    );
  });

  it.each([
    [401, {}, 'authentication_required'],
    [403, {}, 'permission_denied'],
    [429, { 'retry-after': '60' }, 'rate_limited'],
  ] as const)('preserves blob response semantics for HTTP %s', async (status, headers, expected) => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_test');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/octo/one') return repoResponse('octo/one');
      if (url.pathname === '/search/code') return searchResponse('octo/one', [{}]);
      return new Response(null, { status, headers });
    }) as typeof fetch;

    if (expected === 'authentication_required') {
      await assert.rejects(
        () => searchIndexedRepositoryCode(
          { repositories: ['octo/one'], query: 'needle' },
          { fetchImpl },
        ),
        errorCode(expected),
      );
      return;
    }
    const result = await searchIndexedRepositoryCode(
      { repositories: ['octo/one'], query: 'needle' },
      { fetchImpl },
    );
    assert.deepEqual(result.warnings, [expected]);
    assert.equal(result.status, 'partial');
  });
});
