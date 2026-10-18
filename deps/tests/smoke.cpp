// Smoke test for the sysroot: links all dependencies into one program and calls
// something real in each lib. Runs with node (pthreads on, like WebKit later).
#include <cstdio>
#include <cstring>
#include <string>

#include <brotli/decode.h>
#include <curl/curl.h>
#include <expat.h>
#include <fontconfig/fontconfig.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <harfbuzz/hb-icu.h>
#include <harfbuzz/hb.h>
#include <jpeglib.h>
#include <libpsl.h>
#include <libxml/parser.h>
#include <libxslt/xslt.h>
#include <libxslt/xsltconfig.h>
#include <nghttp2/nghttp2.h>
#include <openssl/evp.h>
#include <openssl/ssl.h>
#include <png.h>
#include <sqlite3.h>
#include <unicode/ubrk.h>
#include <unicode/ucol.h>
#include <unicode/uversion.h>
#include <webp/decode.h>
#include <webp/demux.h>
#include <woff2/decode.h>
#include <zlib.h>
#include <zstd.h>

static int failures = 0;

static void check(const char* name, bool ok, const std::string& info)
{
    std::printf("%-14s %s  %s\n", name, ok ? "ok  " : "FAIL", info.c_str());
    if (!ok)
        failures++;
}

int main()
{
    // zlib: compress and decompress again
    {
        const char text[] = "hallo hallo hallo hallo hallo";
        unsigned char packed[128];
        unsigned char unpacked[128];
        uLongf packedLen = sizeof(packed);
        uLongf unpackedLen = sizeof(unpacked);
        bool ok = compress(packed, &packedLen, reinterpret_cast<const Bytef*>(text), sizeof(text)) == Z_OK
            && uncompress(unpacked, &unpackedLen, packed, packedLen) == Z_OK
            && !std::memcmp(text, unpacked, sizeof(text));
        check("zlib", ok, zlibVersion());
    }

    check("brotli", BrotliDecoderVersion() > 0, std::to_string(BrotliDecoderVersion() >> 24) + "." + std::to_string((BrotliDecoderVersion() >> 12) & 0xFFF));
    check("zstd", ZSTD_versionNumber() > 0, ZSTD_versionString());
    check("libpng", png_access_version_number() > 0, PNG_LIBPNG_VER_STRING);

    {
        jpeg_decompress_struct cinfo;
        jpeg_error_mgr jerr;
        cinfo.err = jpeg_std_error(&jerr);
        jpeg_create_decompress(&cinfo);
        jpeg_destroy_decompress(&cinfo);
        check("libjpeg", true, "JPEG_LIB_VERSION " + std::to_string(JPEG_LIB_VERSION));
    }

    check("libwebp", WebPGetDecoderVersion() > 0 && WebPGetDemuxVersion() > 0, std::to_string(WebPGetDecoderVersion()));
    check("expat", true, XML_ExpatVersion());

    {
        const char doc[] = "<root><a>1</a><b>2</b></root>";
        xmlDocPtr d = xmlReadMemory(doc, sizeof(doc) - 1, "test.xml", nullptr, 0);
        bool ok = d && xmlDocGetRootElement(d) && !std::strcmp(reinterpret_cast<const char*>(xmlDocGetRootElement(d)->name), "root");
        if (d)
            xmlFreeDoc(d);
        check("libxml2", ok, LIBXML_DOTTED_VERSION);
    }

    check("libxslt", xsltLibxsltVersion > 0, LIBXSLT_DOTTED_VERSION);

    {
        sqlite3* db = nullptr;
        bool ok = sqlite3_open(":memory:", &db) == SQLITE_OK
            && sqlite3_exec(db, "CREATE TABLE t(x); INSERT INTO t VALUES (42);", nullptr, nullptr, nullptr) == SQLITE_OK;
        sqlite3_close(db);
        check("sqlite", ok, sqlite3_libversion());
    }

    {
        UVersionInfo v;
        char vs[U_MAX_VERSION_STRING_LENGTH];
        u_getVersion(v);
        u_versionToString(v, vs);
        // Collation needs the built-in ICU data, so this tests it too.
        UErrorCode status = U_ZERO_ERROR;
        UCollator* coll = ucol_open("de_CH", &status);
        bool ok = U_SUCCESS(status) && coll;
        if (coll) {
            UChar a[] = { 0x00E4, 0 }; // ae
            UChar z[] = { 'z', 0 };
            ok = ok && ucol_strcoll(coll, a, -1, z, -1) == UCOL_LESS;
            ucol_close(coll);
        }
        UBreakIterator* bi = ubrk_open(UBRK_WORD, "en", nullptr, 0, &status);
        ok = ok && U_SUCCESS(status) && bi;
        if (bi)
            ubrk_close(bi);
        check("icu", ok, std::string(vs) + " " + u_errorName(status));
    }

    {
        FT_Library ft;
        FT_Int major, minor, patch;
        bool ok = FT_Init_FreeType(&ft) == 0;
        if (ok) {
            FT_Library_Version(ft, &major, &minor, &patch);
            FT_Done_FreeType(ft);
        }
        check("freetype", ok, ok ? std::to_string(major) + "." + std::to_string(minor) + "." + std::to_string(patch) : "");
    }

    {
        hb_buffer_t* buf = hb_buffer_create();
        hb_buffer_set_unicode_funcs(buf, hb_icu_get_unicode_funcs());
        hb_buffer_add_utf8(buf, "Grüezi", -1, 0, -1);
        hb_buffer_guess_segment_properties(buf);
        bool ok = hb_buffer_get_length(buf) == 6 && hb_buffer_get_script(buf) == HB_SCRIPT_LATIN;
        hb_buffer_destroy(buf);
        check("harfbuzz", ok, hb_version_string());
    }

    check("fontconfig", FcGetVersion() > 0, std::to_string(FcGetVersion()));

    {
        // Broken data must be rejected cleanly
        const uint8_t junk[] = { 'w', 'O', 'F', '2', 0, 0, 0, 0 };
        bool ok = woff2::ComputeWOFF2FinalSize(junk, sizeof(junk)) == 0;
        check("woff2", ok, "decode lib");
    }

    {
        const psl_ctx_t* psl = psl_builtin();
        bool ok = psl && psl_is_public_suffix(psl, "co.uk") && !psl_is_public_suffix(psl, "example.co.uk");
        check("libpsl", ok, psl_get_version());
    }

    {
        unsigned char md[EVP_MAX_MD_SIZE];
        unsigned int len = 0;
        bool ok = EVP_Digest("abc", 3, md, &len, EVP_sha256(), nullptr) && len == 32 && md[0] == 0xba && md[1] == 0x78;
        SSL_CTX* ctx = SSL_CTX_new(TLS_client_method());
        ok = ok && ctx;
        SSL_CTX_free(ctx);
        check("openssl", ok, OpenSSL_version(OPENSSL_VERSION));
    }

    check("nghttp2", nghttp2_version(0) != nullptr, nghttp2_version(0)->version_str);

    {
        curl_global_init(CURL_GLOBAL_DEFAULT);
        curl_version_info_data* info = curl_version_info(CURLVERSION_NOW);
        bool ok = info && (info->features & CURL_VERSION_SSL) && (info->features & CURL_VERSION_HTTP2)
            && (info->features & CURL_VERSION_BROTLI) && (info->features & CURL_VERSION_ZSTD)
            && (info->features & CURL_VERSION_PSL);
        check("curl", ok, std::string(info->version) + " " + info->ssl_version);
        curl_global_cleanup();
    }

    std::printf("%s\n", failures ? "SMOKE TEST FAILED" : "all libs ok");
    return failures ? 1 : 0;
}
