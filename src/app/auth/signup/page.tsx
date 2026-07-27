'use client';

import { useState, useEffect } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { InputText } from 'primereact/inputtext';
import { Password } from 'primereact/password';
import { Button } from 'primereact/button';
import { Card } from 'primereact/card';
import { Message } from 'primereact/message';
import { BrandLogo } from '@/components/layout/brand-logo';
import { MdPersonAdd } from 'react-icons/md';
import { signUp, checkSignupEnabled } from '@/lib/actions/auth';
import { signUpSchema, type SignUpFormData } from '@/lib/schemas/auth.schema';

export default function SignUpPage() {
    const router = useRouter();

    const {
        register,
        handleSubmit,
        control,
        watch,
        formState: { errors },
    } = useForm<SignUpFormData>({
        resolver: zodResolver(signUpSchema),
        defaultValues: {
            name: '',
            email: '',
            password: '',
            confirmPassword: '',
        },
    });

    const password = watch('password');
    const confirmPassword = watch('confirmPassword');

    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        // Check if this might be the first user (for messaging purposes)
        checkSignupEnabled().catch(() => { }); // Ignore errors
    }, []);

    const onSubmit = async (data: SignUpFormData) => {
        setError('');
        setIsLoading(true);

        // Normalize email
        const normalizedEmail = data.email.toLowerCase().trim();

        try {
            const result = await signUp({ name: data.name.trim(), email: normalizedEmail, password: data.password });

            if (!result.success) {
                setError(result.error || 'Failed to create account');
                return;
            }

            // Check if user became admin (first user)
            // const isAdmin = result.data?.role === 'admin';

            // Sign in after successful signup
            const signInResult = await signIn('credentials', {
                email: data.email,
                password: data.password,
                redirect: false,
            });

            if (signInResult?.error) {
                setError('Account created but failed to sign in. Please sign in manually.');
                router.push('/auth/signin');
            } else {
                router.push('/');
                router.refresh();
            }
        } catch {
            setError('An error occurred. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const header = (
        <div className="text-center pt-4">
            <BrandLogo size={56} className="mx-auto mb-3" />
            <h2 className="text-2xl font-semibold text-gray-900">Create your account</h2>
        </div>
    );

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
            <Card header={header} className="w-full max-w-md shadow-lg">
                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
                    {error && (
                        <Message severity="error" text={error} className="w-full" />
                    )}

                    <div className="flex flex-col gap-2">
                        <label htmlFor="name" className="font-medium text-gray-700">
                            Name
                        </label>
                        <InputText
                            id="name"
                            type="text"
                            {...register('name')}
                            placeholder="John Doe"
                            autoComplete="name"
                            maxLength={100}
                            className="w-full"
                        />
                        {errors.name && (
                            <small className="text-red-500">{errors.name.message}</small>
                        )}
                    </div>

                    <div className="flex flex-col gap-2">
                        <label htmlFor="email" className="font-medium text-gray-700">
                            Email
                        </label>
                        <InputText
                            id="email"
                            type="email"
                            {...register('email')}
                            placeholder="you@example.com"
                            autoComplete="email"
                            className="w-full"
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
                                    toggleMask
                                    className="w-full"
                                    inputClassName="w-full"
                                    autoComplete="new-password"
                                    promptLabel="Choose a strong password"
                                    weakLabel="Weak - add more variety"
                                    mediumLabel="Getting better"
                                    strongLabel="Strong password!"
                                />
                            )}
                        />
                        {errors.password && (
                            <small className="text-red-500">{errors.password.message}</small>
                        )}
                        <div className="text-xs text-gray-500 space-y-1">
                            <p className="font-medium">Password requirements:</p>
                            <ul className="list-disc pl-4 space-y-0.5">
                                <li className={password.length >= 8 ? 'text-green-600' : ''}>At least 8 characters</li>
                                <li className={/[a-z]/.test(password) ? 'text-green-600' : ''}>One lowercase letter</li>
                                <li className={/[A-Z]/.test(password) ? 'text-green-600' : ''}>One uppercase letter</li>
                                <li className={/[0-9]/.test(password) ? 'text-green-600' : ''}>One number</li>
                                <li className={/[^a-zA-Z0-9]/.test(password) ? 'text-green-600' : ''}>One special character (!@#$%^&*...)</li>
                            </ul>
                        </div>
                    </div>

                    <div className="flex flex-col gap-2">
                        <label htmlFor="confirmPassword" className="font-medium text-gray-700">
                            Confirm Password
                        </label>
                        <Controller
                            name="confirmPassword"
                            control={control}
                            render={({ field }) => (
                                <Password
                                    id="confirmPassword"
                                    value={field.value}
                                    onChange={(e) => field.onChange(e.target.value)}
                                    placeholder="••••••••"
                                    feedback={false}
                                    toggleMask
                                    className="w-full"
                                    inputClassName="w-full"
                                    autoComplete="new-password"
                                />
                            )}
                        />
                        {errors.confirmPassword && (
                            <small className="text-red-500">{errors.confirmPassword.message}</small>
                        )}
                        {confirmPassword && password !== confirmPassword && !errors.confirmPassword && (
                            <small className="text-red-500">Passwords do not match</small>
                        )}
                    </div>

                    <Button
                        type="submit"
                        label="Create Account"
                        icon={<MdPersonAdd />}
                        loading={isLoading}
                        className="w-full mt-2"
                    />
                </form>

                <p className="mt-6 text-center text-sm text-gray-600">
                    Already have an account?{' '}
                    <Link href="/auth/signin" className="text-accent-600 hover:underline font-medium">
                        Sign in
                    </Link>
                </p>
            </Card>
        </div>
    );
}
