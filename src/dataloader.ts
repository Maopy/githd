// Dataloader is a class that can be used to load data from cache or git repository.

import * as path from 'path';
import * as vs from 'vscode';
import { GitLogEntry, GitRepo, GitService } from './gitService';
import { Tracer } from './tracer';
import { LRUCache } from 'lru-cache';

class Cache {
  // cached log entries count
  static readonly logEntriesCount = 1200;
  // current branch
  branch: string = '';
  // all commits in current branch
  commits: string[] = [];
  // key: history view context, value: GitLogEntry[]
  logEntries = new LRUCache<string, GitLogEntry[]>({ max: 5 });
  // key: history view context, value: total commits count
  counts = new LRUCache<string, number>({ max: 100 });

  constructor() {}

  countKey(branch: string, author: string): string {
    return `${branch},${author}`;
  }

  logEntryKey(branch: string, stash?: boolean, file?: string, line?: number, author?: string): string {
    return `${branch},${stash ? '1' : ''},${file ?? ''},${line ?? ''},${author ?? ''}`;
  }

  clear() {
    this.branch = '';
    this.commits = [];
    this.logEntries.clear();
    this.counts.clear();
  }
}

export class Dataloader {
  private _cache = new Cache();
  private _fsWatcher: vs.FileSystemWatcher | undefined;
  private _repo: GitRepo | undefined;
  private _updating = false;
  private _updateDelay: NodeJS.Timer | undefined;

  constructor(ctx: vs.ExtensionContext, private _gitService: GitService) {
    const repos: GitRepo[] = _gitService.getGitRepos();
    if (repos.length == 1) {
      this.updateRepo(repos[0]);
    }
  }

  async updateRepo(repo: GitRepo): Promise<void> {
    if (this._repo?.root === repo.root) {
      return;
    }

    this._repo = repo;

    const watching: string = path.join(repo.root, '.git', '**');
    Tracer.info(`Dataloader: repo updated. watching ${watching}`);

    if (this._fsWatcher) {
      this._fsWatcher.dispose();
    }
    clearTimeout(this._updateDelay);
    this._cache.clear();
    this._updating = false;

    this._repo = repo;
    this._fsWatcher = vs.workspace.createFileSystemWatcher(watching);
    this._fsWatcher.onDidChange(uri => this._updateCaches(repo, uri));
    this._fsWatcher.onDidCreate(uri => this._updateCaches(repo, uri));
    this._fsWatcher.onDidDelete(uri => this._updateCaches(repo, uri));
    this._updateCaches(repo);
  }

  async getLogEntries(
    repo: GitRepo,
    express: boolean,
    start: number,
    count: number,
    branch: string,
    isStash?: boolean,
    file?: vs.Uri,
    line?: number,
    author?: string
  ): Promise<GitLogEntry[]> {
    if (!this._useCache(repo.root)) {
      return this._gitService.getLogEntries(repo, express, start, count, branch, isStash, file, line, author);
    }

    const key = this._cache.logEntryKey(branch, isStash ?? false, file?.fsPath, line, author);
    const cache: GitLogEntry[] | undefined = this._cache.logEntries.get(key);
    if (cache) {
      if (cache.length < Cache.logEntriesCount) {
        // We have the full log entries
        return cache.slice(start, start + count);
      }

      if (start + count < cache.length) {
        return cache.slice(start, start + count);
      }
    }

    const entries = await this._gitService.getLogEntries(
      repo,
      express,
      start,
      count,
      branch,
      isStash,
      file,
      line,
      author
    );

    // Only update cache when loading the first page
    if (start == 0) {
      // We try to load a bigger first page than we can cache, in this case, we
      // only cache it if we can cache all entries
      if (count >= Cache.logEntriesCount && entries.length < Cache.logEntriesCount) {
        this._cache.logEntries.set(key, entries);
      } else if (count < Cache.logEntriesCount) {
        // Update the cache asynchronously
        setTimeout(async () => {
          const cacheEntries = await this._gitService.getLogEntries(
            repo,
            express,
            0,
            Cache.logEntriesCount,
            branch,
            isStash,
            file,
            line,
            author
          );

          this._cache.logEntries.set(key, cacheEntries);
          Tracer.info(
            `Dataloader: update log entries cache ${key}, ${cacheEntries.length} entries, cache size ${
              this._cache.logEntries.info(key)?.size
            } entries`
          );
        }, 0);
      }
    } else {
      Tracer.info(`Dataloader: cache missing for non-first page ${key}, start {${start}}, count ${count}`);
    }
    return entries;
  }

  async getCommitsCount(repo: GitRepo, branch: string, author?: string): Promise<number> {
    if (!this._useCache(repo.root)) {
      return this._gitService.getCommitsCount(repo, branch, author);
    }

    const key = this._cache.countKey(branch, author ?? '');
    const count: number | undefined = this._cache.counts.get(key);
    if (count) {
      return count;
    }

    const result = await this._gitService.getCommitsCount(repo, branch, author);
    this._cache.counts.set(key, result);
    return result;
  }

  async getCurrentBranch(repo?: GitRepo): Promise<string> {
    if (!repo) {
      return '';
    }

    return this._useCache(repo.root) ? this._cache.branch : (await this._gitService.getCurrentBranch(repo)) ?? '';
  }

  async getNextCommit(repo: GitRepo | undefined, ref: string): Promise<string> {
    if (!repo) {
      return '';
    }

    const commits: string[] = this._useCache(repo.root) ? this._cache.commits : await this._gitService.getCommits(repo);
    const index: number = commits.indexOf(ref);
    return index > 0 ? commits[index - 1] : '';
  }

  async getPreviousCommit(repo: GitRepo | undefined, ref: string): Promise<string> {
    if (!repo) {
      return '';
    }

    const commits: string[] = this._useCache(repo.root) ? this._cache.commits : await this._gitService.getCommits(repo);
    const index: number = commits.indexOf(ref);
    return index >= 0 && index + 1 < commits.length ? commits[index + 1] : '';
  }

  // Returns [has previous commit, has next commit]
  async hasNeighborCommits(repo: GitRepo | undefined, ref: string): Promise<[boolean, boolean]> {
    if (!repo) {
      return [false, false];
    }

    const commits: string[] = this._useCache(repo.root) ? this._cache.commits : await this._gitService.getCommits(repo);
    const index: number = commits.indexOf(ref);
    return [index >= 0 && index + 1 < commits.length, index > 0];
  }

  private async _updateCaches(repo: GitRepo, uri?: vs.Uri): Promise<void> {
    Tracer.verbose(`Dataloader: _updateCaches: current repo:${repo.root}, uri:${uri?.fsPath}`);

    // There will be many related file updates in a short time for a single user git command.
    // We want to batch them together have less updates.
    this._updating = true;
    clearTimeout(this._updateDelay);
    this._updateDelay = setTimeout(async () => {
      Tracer.verbose(`Dataloader: _updateCaches: updating cache for ${repo.root}`);

      const branch = (await this._gitService.getCurrentBranch(repo)) ?? '';
      const [commits, count, logs] = await Promise.all([
        this._gitService.getCommits(repo, branch),
        this._gitService.getCommitsCount(repo, branch),
        this._gitService.getLogEntries(repo, false, 0, Cache.logEntriesCount, branch)
      ]);

      if (this._repo?.root !== repo.root) {
        // The cache data fetching is finished after the repo is changed. We don't update
        Tracer.warning(`Dataloader: different repo: ${repo.root} ${this._repo?.root}`);
        return;
      }

      this._cache.branch = branch;
      this._cache.commits = commits;
      this._cache.counts.set(this._cache.countKey(branch, ''), count);
      this._cache.logEntries.set(this._cache.logEntryKey(branch), logs);
      this._updating = false;

      Tracer.verbose(`Dataloader: _updateCaches: cache updated for ${repo.root}`);
    }, 1000); // Only update cache if there are no more file updates in the last second
  }

  private _useCache(repo: string): boolean {
    if (repo !== this._repo?.root) {
      Tracer.warning(`Dataloader: different repo: ${repo} ${this._repo?.root}`);
      return false;
    }
    if (this._updating) {
      Tracer.info('Dataloader: updating');
      return false;
    }
    return true;
  }
}
