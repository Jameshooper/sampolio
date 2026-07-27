import { describe, it, expect } from 'vitest';
import { signInSchema, signUpSchema } from './auth.schema';

describe('signInSchema', () => {
  it('passes with valid data', () => {
    const result = signInSchema.safeParse({
      email: 'user@example.com',
      password: 'mypassword',
    });
    expect(result.success).toBe(true);
  });

  it('fails with an invalid email', () => {
    const result = signInSchema.safeParse({
      email: 'not-an-email',
      password: 'mypassword',
    });
    expect(result.success).toBe(false);
  });

  it('fails with an empty password', () => {
    const result = signInSchema.safeParse({
      email: 'user@example.com',
      password: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('signUpSchema', () => {
  const validData = {
    name: 'John Doe',
    email: 'john@example.com',
    password: 'Strong1!pass',
    confirmPassword: 'Strong1!pass',
  };

  it('passes with valid data', () => {
    const result = signUpSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('fails when password is too short', () => {
    const result = signUpSchema.safeParse({
      ...validData,
      password: 'Ab1!',
      confirmPassword: 'Ab1!',
    });
    expect(result.success).toBe(false);
  });

  it('fails when passwords do not match', () => {
    const result = signUpSchema.safeParse({
      ...validData,
      confirmPassword: 'DifferentPassword1!',
    });
    expect(result.success).toBe(false);
  });

  it('fails when password is missing a special character', () => {
    const result = signUpSchema.safeParse({
      ...validData,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
    });
    expect(result.success).toBe(false);
  });

  it('fails when password is missing an uppercase letter', () => {
    const result = signUpSchema.safeParse({
      ...validData,
      password: 'weakpass1!',
      confirmPassword: 'weakpass1!',
    });
    expect(result.success).toBe(false);
  });

  it('fails when password is missing a lowercase letter', () => {
    const result = signUpSchema.safeParse({
      ...validData,
      password: 'STRONG1!PASS',
      confirmPassword: 'STRONG1!PASS',
    });
    expect(result.success).toBe(false);
  });

  it('fails when password is missing a number', () => {
    const result = signUpSchema.safeParse({
      ...validData,
      password: 'StrongPass!',
      confirmPassword: 'StrongPass!',
    });
    expect(result.success).toBe(false);
  });

  it('fails with an invalid email', () => {
    const result = signUpSchema.safeParse({
      ...validData,
      email: 'not-valid',
    });
    expect(result.success).toBe(false);
  });

  it('fails when name is empty', () => {
    const result = signUpSchema.safeParse({
      ...validData,
      name: '',
    });
    expect(result.success).toBe(false);
  });
});
