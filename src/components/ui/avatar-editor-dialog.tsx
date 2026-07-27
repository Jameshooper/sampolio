'use client';

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import dynamic from 'next/dynamic';
import type { Area, Point, CropperProps } from 'react-easy-crop';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { Slider } from 'primereact/slider';
import { Message } from 'primereact/message';
import { MdCloudUpload, MdDeleteOutline, MdArrowBack } from 'react-icons/md';
import { UserAvatar } from '@/components/ui/user-avatar';
import { fileToNormalizedImageSrc, cropToAvatarDataUri } from '@/lib/avatar-utils';

// Keep react-easy-crop out of the shared first-load bundle — it only loads once
// the editor is actually opened. (This whole dialog is also imported lazily by
// its callers, which are themselves lazy settings surfaces.) Cropper is a class
// component whose defaultProps cover the "required" props we don't set; the
// Partial cast reflects that (next/dynamic otherwise types them all required).
const Cropper = dynamic(() => import('react-easy-crop'), { ssr: false }) as ComponentType<Partial<CropperProps>>;

interface AvatarEditorDialogProps {
  visible: boolean;
  onHide: () => void;
  currentAvatarUrl?: string | null;
  userName: string;
  userId: string;
  /** Persist the new avatar (data URI), or remove it (null). The dialog owns
   * the UX; the caller owns persistence and any success toast. */
  onSave: (dataUri: string | null) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Shared "Profile picture" editor: pick/drop/paste an image, crop it in a round
 * cropper, and save a 256×256 WebP data URI (or remove the current one). Used by
 * Settings → Account (self) and the admin Users modal (any user).
 */
export function AvatarEditorDialog({
  visible,
  onHide,
  currentAvatarUrl,
  userName,
  userId,
  onSave,
}: AvatarEditorDialogProps) {
  const [stage, setStage] = useState<'pick' | 'crop'>('pick');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset everything whenever the dialog opens.
  useEffect(() => {
    if (visible) {
      setStage('pick');
      setImageSrc(null);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
      setDragActive(false);
      setError('');
      setSaving(false);
    }
  }, [visible]);

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const acceptFile = useCallback(async (file: File | undefined | null) => {
    if (!file) return;
    setError('');
    try {
      const src = await fileToNormalizedImageSrc(file);
      setImageSrc(src);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setStage('crop');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that image.');
    }
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    void acceptFile(e.target.files?.[0]);
    // Allow re-picking the same file after going Back.
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    void acceptFile(e.dataTransfer.files?.[0]);
  };

  // Paste an image from the clipboard while the dialog is open (document-level
  // so it works regardless of which element inside the dialog has focus).
  useEffect(() => {
    if (!visible) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.items ?? [])
        .find((item) => item.type.startsWith('image/'))
        ?.getAsFile();
      if (file) void acceptFile(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [visible, acceptFile]);

  const handleSave = async () => {
    if (!imageSrc || !croppedAreaPixels) return;
    setSaving(true);
    setError('');
    try {
      const dataUri = await cropToAvatarDataUri(imageSrc, croppedAreaPixels);
      const result = await onSave(dataUri);
      if (result.success) {
        onHide();
      } else {
        setError(result.error ?? 'Could not save your photo. Please try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your photo. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await onSave(null);
      if (result.success) {
        onHide();
      } else {
        setError(result.error ?? 'Could not remove your photo. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const showRemove = stage === 'pick' && !!currentAvatarUrl;

  return (
    <Dialog
      header="Profile picture"
      visible={visible}
      onHide={onHide}
      dismissableMask
      draggable={false}
      style={{ width: '30rem' }}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div>
            {stage === 'crop' && (
              <Button label="Back" text severity="secondary" icon={<MdArrowBack />} onClick={() => setStage('pick')} disabled={saving} />
            )}
            {showRemove && (
              <Button label="Remove photo" text severity="danger" icon={<MdDeleteOutline />} onClick={handleRemove} loading={saving} />
            )}
          </div>
          <div className="flex gap-2">
            <Button label="Cancel" text severity="secondary" onClick={onHide} disabled={saving} />
            {stage === 'crop' && (
              <Button label="Save" onClick={handleSave} loading={saving} disabled={!croppedAreaPixels} />
            )}
          </div>
        </div>
      }
    >
      {error && <Message severity="error" text={error} className="w-full mb-3" />}

      {stage === 'pick' ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <UserAvatar userId={userId} name={userName} avatarUrl={currentAvatarUrl} size={56} />
            <span className="text-sm opacity-70">
              {currentAvatarUrl ? 'Your current photo' : `No photo yet — showing your initials`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            className={`w-full min-h-[9rem] rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 p-6 text-center transition-colors ${
              dragActive
                ? 'border-accent-500 bg-accent-50 dark:bg-accent-900/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
            }`}
          >
            <MdCloudUpload className="text-3xl opacity-50" />
            <span className="text-sm opacity-70">Drop an image here, or tap to browse</span>
            <span className="text-xs opacity-40">You can also paste an image</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="relative w-full h-72 bg-black/40 rounded-lg overflow-hidden">
            {imageSrc && (
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                minZoom={1}
                maxZoom={4}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm opacity-70 shrink-0">Zoom</span>
            <Slider
              value={zoom}
              min={1}
              max={4}
              step={0.05}
              onChange={(e) => setZoom(Array.isArray(e.value) ? e.value[0] : e.value)}
              className="flex-1"
              aria-label="Zoom"
            />
          </div>
        </div>
      )}
    </Dialog>
  );
}
