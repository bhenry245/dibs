import { expect, test } from 'vitest'
import { cashAppLink, venmoLink } from './payment.ts'

test('a Venmo link fills in who, how much and what for', () => {
  expect(venmoLink('brandon', 1856, "Luigi's")).toBe(
    "https://venmo.com/brandon?txn=pay&amount=18.56&note=Luigi's",
  )
})

test('a leading @ is removed from a Venmo handle', () => {
  expect(venmoLink(' @brandon ', 500, 'Dibs')).toBe(
    'https://venmo.com/brandon?txn=pay&amount=5.00&note=Dibs',
  )
})

test('a Cash App link fills in who and how much', () => {
  expect(cashAppLink('$brandon', 1856)).toBe('https://cash.app/$brandon/18.56')
  expect(cashAppLink('brandon', 5)).toBe('https://cash.app/$brandon/0.05')
})

test('a handle cannot change where a link goes', () => {
  expect(venmoLink('../evil?x=1', 100, 'a&b=c')).toBe(
    'https://venmo.com/..%2Fevil%3Fx%3D1?txn=pay&amount=1.00&note=a%26b%3Dc',
  )
  expect(cashAppLink('../evil', 100)).toBe('https://cash.app/$..%2Fevil/1.00')
})
