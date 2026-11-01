import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shop } from '../../src/config/shop.ts';
import { inferOwner } from '../../src/domain/booking-text.ts';

const infer = (summary: string, description = '') => inferOwner(summary, description, shop.services);

test('reads the name, number and service from a title in the shop convention', () => {
  assert.deepEqual(infer('Interior detail & wash – John 415-555-1234'), {
    phone: '+14155551234',
    name: 'John',
    serviceId: 'interior-detail-wash',
  });
});

test('accepts other separators and number formats', () => {
  assert.deepEqual(infer('Exterior wash - Maria Lopez (415) 555-1234'), {
    phone: '+14155551234',
    name: 'Maria Lopez',
    serviceId: 'exterior-wash',
  });
  assert.equal(infer('Full detail: Sam +1 415 555 1234')?.name, 'Sam');
});

test('falls back to a number in the description', () => {
  assert.deepEqual(infer('Full detail – Sam', 'Call 4155551234 if late'), {
    phone: '+14155551234',
    name: 'Sam',
    serviceId: 'full-detail',
  });
});

test('an unknown service or missing name is left blank, not guessed', () => {
  assert.deepEqual(infer('Wax job 415-555-1234'), { phone: '+14155551234', name: '', serviceId: '' });
});

test('events without a valid number have no owner', () => {
  assert.equal(infer('Interior detail & wash'), null);
  assert.equal(infer('Staff meeting', 'Room 12, ext 555'), null);
  assert.equal(infer('Exterior wash – Al 015-555-1234'), null);
});

test('matches a service by its short name, and the longest name wins', () => {
  assert.equal(infer('Ceramic coating – Lee 415-555-1234')?.serviceId, 'paint-correction');
  assert.equal(infer('interior detail & wash - Kim 415-555-1234')?.serviceId, 'interior-detail-wash');
});
