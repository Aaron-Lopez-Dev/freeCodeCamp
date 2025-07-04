import Fastify, { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

import { COOKIE_DOMAIN, JWT_SECRET } from '../utils/env';
import { type Token, createAccessToken } from '../utils/tokens';
import cookies, { sign as signCookie, unsign as unsignCookie } from './cookies';
import auth from './auth';

async function setupServer() {
  const fastify = Fastify();
  await fastify.register(cookies);
  await fastify.register(auth);
  return fastify;
}

const THIRTY_DAYS_IN_SECONDS = 2592000;

describe('auth', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    fastify = await setupServer();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('setAccessTokenCookie', () => {
    // We won't need to keep doubly signing the cookie when we migrate the
    // authentication, but for the MVP we have to be able to read the cookies
    // set by the api-server. So, double signing:
    it('should doubly sign the cookie', async () => {
      const token = createAccessToken('test-id');
      fastify.get('/test', async (req, reply) => {
        reply.setAccessTokenCookie(token);
        return { ok: true };
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/test'
      });

      const { value, ...rest } = res.cookies[0]!;
      const unsignedOnce = unsignCookie(value);
      const unsignedTwice = jwt.verify(unsignedOnce.value!, JWT_SECRET) as {
        accessToken: Token;
      };
      expect(unsignedTwice.accessToken).toEqual(token);
      expect(rest).toEqual({
        name: 'jwt_access_token',
        path: '/',
        sameSite: 'Lax',
        domain: COOKIE_DOMAIN,
        maxAge: THIRTY_DAYS_IN_SECONDS,
        httpOnly: true,
        secure: true
      });
    });
  });

  describe('authorize', () => {
    beforeEach(() => {
      fastify.get('/test', (_req, reply) => {
        void reply.send({ ok: true });
      });
      fastify.addHook('onRequest', fastify.authorize);
    });

    it('should deny if the access token is missing', async () => {
      expect.assertions(4);

      fastify.addHook('onRequest', (req, _reply, done) => {
        expect(req.accessDeniedMessage).toEqual({
          type: 'info',
          content: 'Access token is required for this request'
        });
        expect(req.user).toBeNull();
        done();
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/test'
      });

      expect(res.json()).toEqual({ ok: true });
      expect(res.statusCode).toEqual(200);
    });

    it('should deny if the access token is not signed', async () => {
      expect.assertions(4);

      fastify.addHook('onRequest', (req, _reply, done) => {
        expect(req.accessDeniedMessage).toEqual({
          type: 'info',
          content: 'Access token is required for this request'
        });
        expect(req.user).toBeNull();
        done();
      });

      const token = jwt.sign(
        { accessToken: createAccessToken('123') },
        JWT_SECRET
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test',
        cookies: {
          jwt_access_token: token
        }
      });

      expect(res.json()).toEqual({ ok: true });
      expect(res.statusCode).toEqual(200);
    });

    it('should deny if the access token is invalid', async () => {
      expect.assertions(4);

      fastify.addHook('onRequest', (req, _reply, done) => {
        expect(req.accessDeniedMessage).toEqual({
          type: 'info',
          content: 'Your access token is invalid'
        });
        expect(req.user).toBeNull();
        done();
      });

      const token = jwt.sign(
        { accessToken: createAccessToken('123') },
        'invalid-secret'
      );

      const res = await fastify.inject({
        method: 'GET',
        url: '/test',
        cookies: {
          jwt_access_token: signCookie(token)
        }
      });

      expect(res.json()).toEqual({ ok: true });
      expect(res.statusCode).toEqual(200);
    });

    it('should deny if the access token has expired', async () => {
      expect.assertions(4);

      fastify.addHook('onRequest', (req, _reply, done) => {
        expect(req.accessDeniedMessage).toEqual({
          type: 'info',
          content: 'Access token is no longer valid'
        });
        expect(req.user).toBeNull();
        done();
      });

      const token = jwt.sign(
        { accessToken: createAccessToken('123', -1) },
        JWT_SECRET
      );

      const res = await fastify.inject({
        method: 'GET',
        url: '/test',
        cookies: {
          jwt_access_token: signCookie(token)
        }
      });

      expect(res.json()).toEqual({ ok: true });
      expect(res.statusCode).toEqual(200);
    });

    it('should deny if the user is not found', async () => {
      expect.assertions(4);

      fastify.addHook('onRequest', (req, _reply, done) => {
        expect(req.accessDeniedMessage).toEqual({
          type: 'info',
          content: 'Your access token is invalid'
        });
        expect(req.user).toBeNull();
        done();
      });

      // @ts-expect-error prisma isn't defined, since we're not building the
      // full application here.
      fastify.prisma = { user: { findUnique: () => null } };
      const token = jwt.sign(
        { accessToken: createAccessToken('123') },
        JWT_SECRET
      );

      const res = await fastify.inject({
        method: 'GET',
        url: '/test',
        cookies: {
          jwt_access_token: signCookie(token)
        }
      });

      expect(res.json()).toEqual({ ok: true });
      expect(res.statusCode).toEqual(200);
    });

    it('should populate the request with the user if the token is valid', async () => {
      const fakeUser = { id: '123', username: 'test-user' };
      // @ts-expect-error prisma isn't defined, since we're not building the
      // full application here.
      fastify.prisma = { user: { findUnique: () => fakeUser } };
      fastify.get('/test-user', req => {
        expect(req.user).toEqual(fakeUser);
        return { ok: true };
      });

      const token = jwt.sign(
        { accessToken: createAccessToken('123') },
        JWT_SECRET
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-user',
        cookies: {
          jwt_access_token: signCookie(token)
        }
      });

      expect(res.json()).toEqual({ ok: true });
      expect(res.statusCode).toEqual(200);
    });
  });

  describe('onRequest Hook', () => {
    it('should update the jwt_access_token to httpOnly and secure', async () => {
      const rawValue = 'should-not-change';
      fastify.get('/test', (req, reply) => {
        reply.send({ ok: true });
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/test',
        cookies: {
          jwt_access_token: signCookie(rawValue)
        }
      });

      expect(res.cookies[0]).toMatchObject({
        httpOnly: true,
        secure: true,
        value: signCookie(rawValue),
        maxAge: THIRTY_DAYS_IN_SECONDS
      });

      expect(res.json()).toStrictEqual({ ok: true });
      expect(res.statusCode).toBe(200);
    });

    it('should do nothing if there is no jwt_access_token', async () => {
      fastify.get('/test', (req, reply) => {
        reply.send({ ok: true });
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/test'
      });

      expect(res.cookies).toHaveLength(0);
      expect(res.json()).toStrictEqual({ ok: true });
      expect(res.statusCode).toBe(200);
    });
  });
});
