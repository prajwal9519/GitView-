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

export async function getPreviewHistory(req, res, next) {
  try {
    const history = await repoService.getPreviewHistory(req.user.id);
    res.json({ data: history });
  } catch (err) {
    next(err);
  }
}

export async function detectRepository(req, res, next) {
  try {
    const { ref } = req.query;
    const detection = await repoService.detectRepositoryProject(req.user.id, req.params.id, ref);
    res.json({ data: detection });
  } catch (err) {
    next(err);
  }
}

export async function getRepositoryDependencies(req, res, next) {
  try {
    const { ref } = req.query;
    const dependencies = await repoService.getRepositoryDependencies(req.user.id, req.params.id, ref);
    res.json({ data: dependencies });
  } catch (err) {
    next(err);
  }
}
