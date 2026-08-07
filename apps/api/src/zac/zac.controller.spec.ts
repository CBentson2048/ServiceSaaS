import 'reflect-metadata';
import { ZacController } from './zac.controller';

/**
 * The controller's guard metadata IS the access policy for the ZAC surface —
 * these assertions pin it so a role or permission cannot be widened (or the
 * zac.access requirement dropped) without a failing test.
 */
describe('ZacController access metadata', () => {
  it('admits exactly owner, manager and stylist', () => {
    expect(Reflect.getMetadata('sheer:roles', ZacController)).toEqual([
      'owner',
      'manager',
      'stylist',
    ]);
  });

  it('requires zac.access for every route', () => {
    expect(Reflect.getMetadata('sheer:permissions', ZacController)).toEqual(['zac.access']);
  });
});
