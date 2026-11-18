import * as repoService from './repositories.service.js';

export async function importRepository(req, res, next) {
  try {
    const { repo } = req.body;
    const repository = await repoService.importRepository(req.user.id, repo);
    res.status(201).json({ data: { repository } });
  } catch (err) {
    next(err);
  }
}

export async function listRepositories(req, res, next) {
  try {
    const repositories = await repoService.listRepositories(req.user.id);
    res.json({ data: repositories });
  } catch (err) {
    next(err);
  }
}

export async function getRepository(req, res, next) {
  try {
    const repository = await repoService.getRepositoryById(req.user.id, req.params.id);
    res.json({ data: { repository } });
  } catch (err) {
    next(err);
  }
}

export async function deleteRepository(req, res, next) {
  try {
    const result = await repoService.deleteRepository(req.user.id, req.params.id);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getDirectoryTree(req, res, next) {
  try {
    const { path, ref } = req.query;
    const tree = await repoService.getDirectoryTree(req.user.id, req.params.id, { path, ref });
    res.json({ data: tree });
  } catch (err) {
    next(err);
  }
}

export async function getFileContent(req, res, next) {
  try {
    const { path, ref } = req.query;
    const file = await repoService.getFileContent(req.user.id, req.params.id, { path, ref });
    res.json({ data: file });
  } catch (err) {
    next(err);
  }
}
