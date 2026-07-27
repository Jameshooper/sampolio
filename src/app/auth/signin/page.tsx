'use client';

import { useState, Suspense, useEffect, useRef } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { InputText } from 'primereact/inputtext';
import { Password } from 'primereact/password';
import { Button } from 'primereact/button';
import { Card } from 'primereact/card';
import { Message } from 'primereact/message';
import { BrandLogo } from '@/components/layout/brand-logo';
import { MdLogin, MdSync } from 'react-icons/md';
import { signInSchema, type SignInFormData } from '@/lib/schemas/auth.schema';

// Constants for rate limiting feedback.
// Keep MAX_FAILED_ATTEMPTS in sync with the server-side value in src/lib/db/users.ts.
const MAX_FAILED_ATTEMPTS = 10;
const MAX_ATTEMPTS_BEFORE_WARNING = 7;
const LOCKOUT_WARNING_THRESHOLD = 9;

function SignInForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const callbackUrl = searchParams.get('callbackUrl') || '/';

    const {
        register,
        handleSubmit,
        control,
        formState: { errors },
    } = useForm<SignInFormData>({
        resolver: zodResolver(signInSchema),
        defaultValues: {
            email: '',
            password: '',
        },
    });

    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [attemptCount, setAttemptCount] = useState(0);
    const [isLocked, setIsLocked] = useState(false);
    const [lockoutTimeRemaining, setLockoutTimeRemaining] = useState(0);

    const lockoutTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (lockoutTimerRef.current) {
                clearInterval(lockoutTimerRef.current);
            }
        };
    }, []);

    // Handle lockout countdown
    useEffect(() => {
        if (lockoutTimeRemaining > 0) {
            lockoutTimerRef.current = setInterval(() => {
                setLockoutTimeRemaining((prev) => {
                    if (prev <= 1) {
                        setIsLocked(false);
                        if (lockoutTimerRef.current) {
                            clearInterval(lockoutTimerRef.current);
                        }
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
        }

        return () => {
            if (lockoutTimerRef.current) {
                clearInterval(lockoutTimerRef.current);
            }
        };
    }, [lockoutTimeRemaining]);

    const onSubmit = async (data: SignInFormData) => {
        if (isLocked) {
            return;
        }

        setError('');
        setIsLoading(true);

        try {
            const result = await signIn('credentials', {
                email: data.email.trim().toLowerCase(),
                password: data.password,
                redirect: false,
            });

            if (result?.error) {
                const newAttemptCount = attemptCount + 1;
                setAttemptCount(newAttemptCount);

                if (newAttemptCount >= LOCKOUT_WARNING_THRESHOLD) {
                    setError('Invalid credentials. Your account may be temporarily locked after too many failed attempts.');
                } else if (newAttemptCount >= MAX_ATTEMPTS_BEFORE_WARNING) {
                    setError(`Invalid email or password. ${MAX_FAILED_ATTEMPTS - newAttemptCount} attempts remaining before temporary lockout.`);
                } else {
                    setError('Invalid email or password');
                }
            } else {
                // Clear attempt count on success
                setAttemptCount(0);
                router.push(callbackUrl);
                router.refresh();
            }
        } catch (err) {
            // Check if it's a rate limit error
            if (err instanceof Response && err.status === 429) {
                const data = await err.json();
                setIsLocked(true);
                setLockoutTimeRemaining(data.retryAfter || 60);
                setError('Too many login attempts. Please wait before trying again.');
            } else {
                setError('An error occurred. Please try again.');
            }
        } finally {
            setIsLoading(false);
        }
    };

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    };

    const header = (
        <div className="text-center pt-4">
            <BrandLogo size={56} className="mx-auto mb-3" />
            <h2 className="text-2xl font-bold  text-gray-900">Sign in to Sampolio</h2>
        </div>
    );

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
            <Card header={header} className="w-full max-w-md shadow-lg">
                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
                    {error && (
                        <Message severity="error" text={error} className="w-full" />
                    )}

                    {isLocked && lockoutTimeRemaining > 0 && (
                        <Message
                            severity="warn"
                            text={`Please wait ${formatTime(lockoutTimeRemaining)} before trying again.`}
                            className="w-full"
                        />
                    )}

                    <div className="flex flex-col gap-2">
                        <label htmlFor="email" className="font-medium text-gray-700">
                            Email
                        </label>
                        <InputText
                            id="email"
                            type="email"
                            {...register('email')}
                            placeholder="you@example.com"
                            disabled={isLocked}
                            className="w-full"
                            autoComplete="email"
                        />
                        {errors.email && (
                            <small className="text-red-500">{errors.email.message}</small>
                        )}
                    </div>

                    <div className="flex flex-col gap-2">
                        <label htmlFor="password" className="font-medium text-gray-700">
                            Password
                        </label>
                        <Controller
                            name="password"
                            control={control}
                            render={({ field }) => (
                                <Password
                                    id="password"
                                    value={field.value}
                                    onChange={(e) => field.onChange(e.target.value)}
                                    placeholder="••••••••"
                                    disabled={isLocked}
                                    feedback={false}
                                    toggleMask
                                    className="w-full"
                                    inputClassName="w-full"
                                    autoComplete="current-password"
                                />
                            )}
                        />
                        {errors.password && (
                            <small className="text-red-500">{errors.password.message}</small>
                        )}
                    </div>

                    <Button
                        type="submit"
                        label={isLocked ? `Locked (${formatTime(lockoutTimeRemaining)})` : 'Sign In'}
                        icon={<MdLogin />}
                        loading={isLoading}
                        disabled={isLocked}
                        className="w-full mt-2"
                    />
                </form>

                <p className="mt-6 text-center text-sm text-gray-600">
                    Don&apos;t have an account?{' '}
                    <Link href="/auth/signup" className="text-accent-600 hover:underline font-medium">
                        Sign up
                    </Link>
                </p>
            </Card>
        </div>
    );
}

export default function SignInPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center bg-gray-50">
                    <MdSync size={36} className="text-accent-600 animate-spin" />
                </div>
            }
        >
            <SignInForm />
        </Suspense>
    );
}
