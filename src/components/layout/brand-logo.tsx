'use client';

import { useId } from 'react';

/**
 * Sampolio brand mark — the app icon (euro coin + rising chart, money-green),
 * rendered inline so it needs no network fetch and stays crisp at any size.
 * Mirrors public/icons/icon.svg exactly. The tile gradient id is scoped with
 * useId() because the sidebar, mobile top bar and drawer are all mounted at
 * once (CSS only toggles their visibility) — duplicate SVG ids in one document
 * are invalid and would make url(#…) references ambiguous.
 */
export function BrandLogo({ size = 28, className }: { size?: number; className?: string }) {
    const gid = useId();
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 512 512"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="Sampolio"
            className={className}
        >
            <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="512" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#059669" />
                    <stop offset="1" stopColor="#047857" />
                </linearGradient>
            </defs>
            <rect x="0" y="0" width="512" height="512" rx="112" fill={`url(#${gid})`} />
            <g>
                <rect x="338" y="290" width="40" height="114" rx="11" fill="#ffffff" opacity="0.5" />
                <rect x="398" y="232" width="40" height="172" rx="11" fill="#ffffff" opacity="0.72" />
                <rect x="458" y="158" width="40" height="246" rx="11" fill="#ffffff" opacity="0.95" />
                <path d="M336 258 L418 186 L478 116" fill="none" stroke="#ffffff" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            <circle cx="170" cy="332" r="158" fill="#059669" />
            <circle cx="170" cy="332" r="146" fill="#ffffff" />
            <path d="M218.9 264.2 A86 86 0 1 0 218.9 399.8" fill="none" stroke="#059669" strokeWidth="34" strokeLinecap="round" />
            <path d="M75.7 306.2 L195.2 306.2 M79.7 340.6 L195.2 340.6" fill="none" stroke="#059669" strokeWidth="27.9" strokeLinecap="round" />
        </svg>
    );
}
