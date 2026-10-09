#!/usr/bin/env python3
"""Ký APK BMBPlayer: v1 (jarsigner, cho Android 5–6) + căn lề 4 byte + v2 (Android 7 trở lên).

Dùng khi không có Android build-tools (apksigner/zipalign). Chỉ cần JDK (jarsigner) + Python + gói `cryptography`.

    python3 sign_apk.py <vao-chua-ky.apk> <ra-da-ky.apk> <khoa.p12> <alias> <mat-khau>

Định dạng v2 theo đặc tả "APK Signature Scheme v2" của Android (thuật toán 0x0103 RSA PKCS#1 v1.5 + SHA-256 theo khối 1 MB).
"""
import hashlib, os, struct, subprocess, sys, tempfile, zipfile
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import pkcs12

EOCD_SIG, CD_SIG, LFH_SIG, DD_SIG = 0x06054b50, 0x02014b50, 0x04034b50, 0x08074b50
ALG_RSA_PKCS1_SHA256 = 0x0103
V2_BLOCK_ID = 0x7109871a
CHUNK = 1024 * 1024


def find_eocd(b):
    i = b.rfind(struct.pack('<I', EOCD_SIG), max(0, len(b) - 65557))
    if i < 0:
        raise SystemExit('Không phải file zip/APK hợp lệ')
    return i


def entries(b):
    e = find_eocd(b)
    n = struct.unpack_from('<H', b, e + 10)[0]
    cd_size, cd_off = struct.unpack_from('<II', b, e + 12)
    out, p = [], cd_off
    for _ in range(n):
        assert struct.unpack_from('<I', b, p)[0] == CD_SIG, 'central directory hỏng'
        (flags, method, csize, usize, nlen, xlen, clen, lho) = (
            struct.unpack_from('<H', b, p + 8)[0], struct.unpack_from('<H', b, p + 10)[0],
            struct.unpack_from('<I', b, p + 20)[0], struct.unpack_from('<I', b, p + 24)[0],
            struct.unpack_from('<H', b, p + 28)[0], struct.unpack_from('<H', b, p + 30)[0],
            struct.unpack_from('<H', b, p + 32)[0], struct.unpack_from('<I', b, p + 42)[0])
        rec = bytearray(b[p:p + 46 + nlen + xlen + clen])
        out.append(dict(flags=flags, method=method, csize=csize, lho=lho, cd=rec, name=b[p + 46:p + 46 + nlen]))
        p += 46 + nlen + xlen + clen
    return out, e, cd_off, cd_size


def align(src, align_to=4):
    """Giống zipalign -f 4: dữ liệu của mục KHÔNG NÉN bắt đầu ở vị trí chia hết cho 4."""
    b = open(src, 'rb').read()
    ents, e, _, _ = entries(b)
    out = bytearray()
    for it in ents:
        p = it['lho']
        assert struct.unpack_from('<I', b, p)[0] == LFH_SIG, 'local header hỏng'
        nlen, xlen = struct.unpack_from('<HH', b, p + 26)
        hdr = bytearray(b[p:p + 30])
        name = b[p + 30:p + 30 + nlen]
        extra = bytes(b[p + 30 + nlen:p + 30 + nlen + xlen])
        data_start = p + 30 + nlen + xlen
        data = b[data_start:data_start + it['csize']]
        tail = b''
        if it['flags'] & 0x08:                       # có data descriptor sau dữ liệu
            q = data_start + it['csize']
            tail = b[q:q + 16] if struct.unpack_from('<I', b, q)[0] == DD_SIG else b[q:q + 12]
        new_off = len(out)
        if it['method'] == 0:
            pad = (-(new_off + 30 + nlen + len(extra))) % align_to
            extra = extra + b'\x00' * pad
        struct.pack_into('<H', hdr, 28, len(extra))
        out += hdr + name + extra + data + tail
        struct.pack_into('<I', it['cd'], 42, new_off)
    cd_off = len(out)
    for it in ents:
        out += it['cd']
    cd_size = len(out) - cd_off
    eocd = bytearray(b[e:])
    struct.pack_into('<II', eocd, 12, cd_size, cd_off)
    out += eocd
    return bytes(out)


def lp(x):
    return struct.pack('<I', len(x)) + x


def chunked_sha256(sections):
    digests, count = [], 0
    for s in sections:
        for i in range(0, len(s), CHUNK):
            c = s[i:i + CHUNK]
            digests.append(hashlib.sha256(b'\xa5' + struct.pack('<I', len(c)) + c).digest())
            count += 1
    return hashlib.sha256(b'\x5a' + struct.pack('<I', count) + b''.join(digests)).digest()


def sign_v2(apk, key, cert_der):
    e = find_eocd(apk)
    cd_size, cd_off = struct.unpack_from('<II', apk, e + 12)
    if apk[cd_off - 16:cd_off] == b'APK Sig Block 42':
        raise SystemExit('APK đã có khối chữ ký — dùng bản chưa ký')
    digest = chunked_sha256([apk[:cd_off], apk[cd_off:e], apk[e:]])
    signed_data = (lp(lp(struct.pack('<I', ALG_RSA_PKCS1_SHA256) + lp(digest)))
                   + lp(lp(cert_der))
                   + lp(b''))
    sig = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA256())
    pub = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    signer = lp(signed_data) + lp(lp(struct.pack('<I', ALG_RSA_PKCS1_SHA256) + lp(sig))) + lp(pub)
    value = lp(lp(signer))
    pairs = struct.pack('<Q', 4 + len(value)) + struct.pack('<I', V2_BLOCK_ID) + value
    size = len(pairs) + 8 + 16
    block = struct.pack('<Q', size) + pairs + struct.pack('<Q', size) + b'APK Sig Block 42'
    eocd = bytearray(apk[e:])
    struct.pack_into('<I', eocd, 16, cd_off + len(block))
    return apk[:cd_off] + block + apk[cd_off:e] + bytes(eocd)


def main():
    if len(sys.argv) != 6:
        raise SystemExit(__doc__)
    src, dst, ks, alias, pw = sys.argv[1:]
    with zipfile.ZipFile(src) as z:
        if any(n.upper().startswith('META-INF/') and n.upper().endswith(('.SF', '.RSA', '.DSA', '.EC')) for n in z.namelist()):
            raise SystemExit('APK đã có chữ ký v1 — dùng bản chưa ký')
    key, cert, _ = pkcs12.load_key_and_certificates(open(ks, 'rb').read(), pw.encode())
    cert_der = cert.public_bytes(serialization.Encoding.DER)
    with tempfile.TemporaryDirectory() as t:
        v1 = os.path.join(t, 'v1.apk')
        subprocess.run(['jarsigner', '-keystore', ks, '-storetype', 'PKCS12', '-storepass', pw,
                        '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256', '-signedjar', v1, src, alias],
                       check=True, stdout=subprocess.DEVNULL)
        aligned = align(v1)
    out = sign_v2(aligned, key, cert_der)
    open(dst, 'wb').write(out)
    print('Đã ký:', dst, len(out), 'byte')


if __name__ == '__main__':
    main()
