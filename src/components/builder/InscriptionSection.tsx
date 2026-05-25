'use client';

import { useEffect, useRef, useState } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { getInscription } from '@/lib/api/ordinals';
import { MAX_INSCRIPTION_SIZE } from '@/types';
import SectionWrapper from './SectionWrapper';

type InscriptionMode = 'file' | 'delegate';

export default function InscriptionSection() {
  const inscriptionFile = useBuilderStore((s) => s.inscriptionFile);
  const setInscriptionFile = useBuilderStore((s) => s.setInscriptionFile);
  const delegateInscriptionId = useBuilderStore((s) => s.delegateInscriptionId);
  const setDelegateInscriptionId = useBuilderStore((s) => s.setDelegateInscriptionId);
  const wallet = useBuilderStore((s) => s.wallet);
  const isTestnet = wallet.taprootAddress.startsWith('tb1');

  const [inscriptionMode, setInscriptionMode] = useState<InscriptionMode>(
    delegateInscriptionId ? 'delegate' : 'file'
  );

  // File upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const MAX_FILE_SIZE = MAX_INSCRIPTION_SIZE;

  // Delegate state
  const [delegateId, setDelegateId] = useState(delegateInscriptionId ?? '');
  const [delegateVerify, setDelegateVerify] = useState<'idle' | 'loading' | 'ok' | 'error'>(
    delegateInscriptionId ? 'ok' : 'idle'
  );
  const [delegateInfo, setDelegateInfo] = useState<{ contentType: string; id: string } | null>(
    delegateInscriptionId ? { contentType: 'restored from bundle', id: delegateInscriptionId } : null
  );
  const [delegateError, setDelegateError] = useState('');

  // Sync FROM store when bundle load changes delegate/file externally.
  // (Restoring inscriptionFile is automatic — it's read from store directly above.)
  useEffect(() => {
    setDelegateId(delegateInscriptionId ?? '');
    if (delegateInscriptionId) {
      setDelegateVerify('ok');
      setDelegateInfo((prev) => prev ?? { contentType: 'restored from bundle', id: delegateInscriptionId });
    }
  }, [delegateInscriptionId]);

  // Re-infer mode whenever store contents change (bundle resume picks the right tab).
  useEffect(() => {
    if (delegateInscriptionId) setInscriptionMode('delegate');
    else if (inscriptionFile) setInscriptionMode('file');
  }, [delegateInscriptionId, inscriptionFile]);

  const INSCRIPTION_ID_REGEX = /^[0-9a-fA-F]{64}i\d+$/;

  function switchMode(mode: InscriptionMode) {
    setInscriptionMode(mode);
    if (mode === 'file') {
      setDelegateInscriptionId(null);
      setDelegateId('');
      setDelegateVerify('idle');
    } else {
      setInscriptionFile(null);
      setFileError(null);
    }
  }

  // --- File upload ---
  function readFile(file: File) {
    setFileError(null);
    if (file.size > MAX_FILE_SIZE) {
      setFileError(`File too large (${(file.size / 1024).toFixed(1)} KB). Maximum is ${MAX_FILE_SIZE / 1024} KB.`);
      return;
    }
    if (file.size === 0) { setFileError('File is empty.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = e.target?.result as ArrayBuffer;
      setInscriptionFile({ contentType: file.type || 'application/octet-stream', body: new Uint8Array(buf) });
    };
    reader.readAsArrayBuffer(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  }

  // --- Delegate verify ---
  async function handleDelegateVerify() {
    const id = delegateId.trim();
    if (!INSCRIPTION_ID_REGEX.test(id)) {
      setDelegateVerify('error');
      setDelegateError('Invalid inscription ID format.');
      return;
    }
    setDelegateVerify('loading');
    setDelegateError('');

    // On testnet, skip ordinals.com — trust the ID format
    if (isTestnet) {
      setDelegateInscriptionId(id);
      setDelegateInfo({ contentType: 'testnet (unverified)', id });
      setDelegateVerify('ok');
      return;
    }

    try {
      const info = await getInscription(id);
      setDelegateInscriptionId(id);
      setDelegateInfo({ contentType: info.content_type ?? 'unknown', id });
      setDelegateVerify('ok');
    } catch (err) {
      setDelegateVerify('error');
      setDelegateError(err instanceof Error ? err.message : 'Inscription not found');
      setDelegateInscriptionId(null);
    }
  }

  function handleDelegateChange(val: string) {
    setDelegateId(val);
    setDelegateVerify('idle');
    setDelegateError('');
    if (!val.trim()) setDelegateInscriptionId(null);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  // Badge: content type if file loaded, "Delegate" if delegate set
  let badge: string | undefined;
  if (inscriptionMode === 'file' && inscriptionFile) {
    badge = inscriptionFile.contentType;
  } else if (inscriptionMode === 'delegate' && delegateInscriptionId) {
    badge = 'Delegate';
  }

  return (
    <SectionWrapper sectionKey="inscription" title="Inscription" badge={badge}>
      <div className="flex flex-col gap-6">
        {/* Mode toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => switchMode('file')}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
              inscriptionMode === 'file'
                ? 'border-orange-500 bg-orange-500/10 text-orange-400'
                : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'
            }`}
          >
            Upload File
          </button>
          <button
            onClick={() => switchMode('delegate')}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
              inscriptionMode === 'delegate'
                ? 'border-orange-500 bg-orange-500/10 text-orange-400'
                : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'
            }`}
          >
            Delegate
          </button>
        </div>

        {/* File upload mode */}
        {inscriptionMode === 'file' && (
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-gray-300">Inscription File</label>
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`cursor-pointer rounded-lg border-2 border-dashed px-6 py-10 flex flex-col items-center gap-3 transition-colors ${
                dragging ? 'border-orange-400 bg-orange-500/10' : 'border-gray-700 bg-gray-900 hover:border-gray-600'
              }`}
            >
              <svg className="w-10 h-10 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <p className="text-sm text-gray-400">{dragging ? 'Drop file here' : 'Click or drag & drop any file'}</p>
              <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
            </div>

            {fileError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{fileError}</div>
            )}

            {inscriptionFile && (
              <div className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white font-medium">File loaded</span>
                  <button onClick={(e) => { e.stopPropagation(); setInscriptionFile(null); }} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Remove</button>
                </div>
                <span className="text-xs text-gray-400"><span className="text-gray-500">Type: </span><span className="font-mono">{inscriptionFile.contentType}</span></span>
                <span className="text-xs text-gray-400"><span className="text-gray-500">Size: </span><span className="font-mono">{formatSize(inscriptionFile.body.length)}</span></span>
              </div>
            )}
          </div>
        )}

        {/* Delegate mode */}
        {inscriptionMode === 'delegate' && (
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-gray-300">Delegate Inscription ID</label>
            <p className="text-xs text-gray-500">
              Point to an existing inscription for content. The etching TX stays tiny — only a 32-byte pointer, no embedded data.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={delegateId}
                onChange={(e) => handleDelegateChange(e.target.value)}
                placeholder="abc123…i0"
                spellCheck={false}
                className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-xs text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
              />
              <button
                onClick={handleDelegateVerify}
                disabled={!delegateId.trim() || delegateVerify === 'loading'}
                className="rounded-lg border border-orange-500 px-4 py-2.5 text-sm font-semibold text-orange-500 hover:bg-orange-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                {delegateVerify === 'loading' ? 'Verifying…' : 'Verify'}
              </button>
            </div>

            {delegateVerify === 'ok' && (
              <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 flex flex-col gap-1">
                <span className="text-xs text-green-400 font-semibold">Delegate verified</span>
                {delegateInfo && (
                  <span className="text-xs text-gray-400 font-mono">Content type: {delegateInfo.contentType}</span>
                )}
                <span className="text-xs text-gray-500">Content will come from this inscription. Your etching TX will be tiny.</span>
              </div>
            )}

            {delegateVerify === 'error' && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
                <span className="text-xs text-red-400">{delegateError}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </SectionWrapper>
  );
}
