import * as usersService from './users.service.js';

export const me = async (req, res) => {
  const user = await usersService.getById(req.user.id);
  res.json({ data: { user } });
};

export const list = async (req, res) => {
  const { page, perPage } = req.query; // already validated and converted by zod
  const { users, total } = await usersService.list({ page, perPage });
  res.json({ data: users, meta: { page, perPage, total } });
};
