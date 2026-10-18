#!/usr/bin/env python3
# Generates the ANGLE replacement of PORT=Wasm (WebGL without ANGLE).
#
# The WebGL of WebKit calls ANGLE entry points (GL_ActiveTexture, EGL_...).
# We do not build ANGLE but forward the calls to the GLES of Emscripten
# (the WebGL of the host browser in the engine worker). This script writes:
#   platform/wasm/angle/ANGLE/entry_points_*.h   declarations GL_*/EGL_*
#   platform/wasm/angle/ANGLEShimForwardWasm.cpp GL_Xxx -> glXxx (generated)
# Everything in CUSTOM is written by hand in ANGLEShimWasm.cpp. The output goes into
# patch 0016, so its texts stay as they are in the patch.
#
#   tools/gen-angle-shim.py [webkit-dir]
import glob
import os
import re
import sys

webkit = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'third_party', 'WebKit')
webcore = os.path.join(webkit, 'Source', 'WebCore')
angle_include = os.path.join(webkit, 'Source', 'ThirdParty', 'ANGLE', 'include')
out_dir = os.path.join(webcore, 'platform', 'wasm', 'angle')

# By hand: missing in Emscripten or needs an adaptation
CUSTOM = {
    # Extensions and strings
    'GL_GetString', 'GL_RequestExtensionANGLE', 'GL_GetTranslatedShaderSourceANGLE',
    # Shared host context: errors, texture units, own default VAO/TF
    'GL_GetError', 'GL_ActiveTexture', 'GL_BindVertexArray', 'GL_BindVertexArrayOES',
    'GL_DeleteVertexArrays', 'GL_DeleteVertexArraysOES', 'GL_BindTransformFeedback', 'GL_DeleteTransformFeedbacks',
    # Emscripten cannot read when mapping
    'GL_MapBufferRange', 'GL_UnmapBuffer',
    # Switches WebGL does not have (primitive restart, debug output)
    'GL_Enable', 'GL_Disable', 'GL_IsEnabled',
    # WebGL1 does not know DEPTH24_STENCIL8/DEPTH_COMPONENT24
    'GL_RenderbufferStorage',
    # ANGLE variants WebGL does not have or names differently
    'GL_BlitFramebufferANGLE', 'GL_BlitFramebufferNV', 'GL_RenderbufferStorageMultisampleANGLE',
    'GL_DiscardFramebufferEXT', 'GL_PolygonModeANGLE', 'GL_ProvokingVertexANGLE',
    'GL_DebugMessageCallbackKHR', 'GL_DebugMessageControlKHR',
    'GL_BlendEquationSeparateiOES', 'GL_BlendEquationiOES', 'GL_BlendFuncSeparateiOES', 'GL_BlendFunciOES',
    'GL_ColorMaskiOES', 'GL_DisableiOES', 'GL_EnableiOES',
}

# Robust variants (ANGLE_robust_client_memory): same function without bufSize/length
ROBUST = re.compile(r'^GL_(\w+)RobustANGLE$')


def used_functions():
    names = set()
    files = glob.glob(os.path.join(webcore, 'platform', 'graphics', 'angle', '*.cpp'))
    files += glob.glob(os.path.join(webcore, 'platform', 'graphics', 'skia', 'GraphicsContextGLSkia.cpp'))
    files += [f for f in glob.glob(os.path.join(out_dir, '*.cpp')) if not f.endswith('ANGLEShimForwardWasm.cpp')]
    files += glob.glob(os.path.join(webcore, 'platform', 'wasm', '*GL*.cpp'))
    for f in files:
        with open(f, encoding='utf-8') as source:
            names.update(re.findall(r'\b((?:GL|EGL)_[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*)\(', source.read()))
    return names


def prototypes():
    found = {}
    headers = glob.glob(os.path.join(angle_include, 'GLES2', '*.h')) + glob.glob(os.path.join(angle_include, 'GLES3', '*.h'))
    headers += glob.glob(os.path.join(angle_include, 'EGL', '*.h'))
    for header in sorted(headers):
        with open(header, encoding='utf-8') as f:
            text = f.read()
        for m in re.finditer(r'(GL_APICALL|EGLAPI)\s+(.*?)\s*(GL_APIENTRY|EGLAPIENTRY)\s+(gl|egl)(\w+)\s*\((.*?)\);', text, re.S):
            prefix = 'GL_' if m.group(4) == 'gl' else 'EGL_'
            entry = (m.group(2).strip(), ' '.join(m.group(6).split()), m.group(3))
            found.setdefault(prefix + m.group(5), entry)
    return found


def argument_names(params):
    if params.strip() in ('', 'void'):
        return []
    names = []
    for param in params.split(','):
        param = param.strip()
        match = re.search(r'(\w+)\s*(\[\s*\d*\s*\])?$', param)
        names.append(match.group(1))
    return names


def main():
    names = sorted(used_functions())
    protos = prototypes()
    missing = [n for n in names if n not in protos]
    if missing:
        sys.exit('No prototype for: ' + ', '.join(missing))

    os.makedirs(os.path.join(out_dir, 'ANGLE'), exist_ok=True)
    declarations = ['// Generiert von tools/gen-angle-shim.py, nicht von Hand aendern.',
                    '#pragma once', '',
                    '#include <EGL/egl.h>', '#include <EGL/eglext.h>', '#include <EGL/eglext_angle.h>',
                    '#include <GLES2/gl2.h>', '#include <GLES2/gl2ext.h>', '#include <GLES2/gl2ext_angle.h>',
                    '#include <GLES3/gl3.h>', '#include <GLES3/gl31.h>', '#include <GLES3/gl32.h>', '',
                    'extern "C" {']
    for name in names:
        ret, params, apientry = protos[name]
        declarations.append(f'{ret} {apientry} {name}({params});')
    declarations += ['}', '']
    with open(os.path.join(out_dir, 'ANGLEShimEntryPoints.h'), 'w') as f:
        f.write('\n'.join(declarations))
    # The names WebKit expects (ANGLEHeaders.h)
    for header in ('entry_points_egl_autogen.h', 'entry_points_egl_ext_autogen.h', 'entry_points_gles_2_0_autogen.h',
                   'entry_points_gles_3_0_autogen.h', 'entry_points_gles_ext_autogen.h'):
        with open(os.path.join(out_dir, 'ANGLE', header), 'w') as f:
            f.write('// browser-lite: siehe tools/gen-angle-shim.py\n#pragma once\n#include "../ANGLEShimEntryPoints.h"\n')

    forward = ['// Generiert von tools/gen-angle-shim.py, nicht von Hand aendern.',
               '// GL_Xxx -> glXxx von Emscripten (WebGL des Host-Browsers).',
               '#include "config.h"', '', '#if ENABLE(WEBGL)', '', '#include "ANGLEShimEntryPoints.h"', '',
               'extern "C" {', '']
    targets = []
    declared = set()
    for name in names:
        robust = ROBUST.match(name)
        if robust and name not in CUSTOM:
            # Same function without the sizes; WebKit does not use length/columns/rows
            ret, params, _ = protos[name]
            base = robust.group(1)
            # Some exist only as EXT (timer queries)
            if 'GL_' + base not in protos and 'GL_' + base + 'EXT' in protos:
                base += 'EXT'
            plain = 'GL_' + base
            target = 'gl' + base
            plain_params = protos[plain][1]
            if target not in declared:
                targets.append(f'{protos[plain][0]} GL_APIENTRY {target}({plain_params});')
                declared.add(target)
            # Arguments of the plain prototype; the size is called bufSize or count there
            robust_args = argument_names(params)
            args = []
            for a in argument_names(plain_params):
                if a not in robust_args and a in ('bufSize', 'count'):
                    a = next(b for b in ('paramCount', 'bufSize') if b in robust_args)
                if a not in robust_args:
                    sys.exit(f'{name}: argument {a} missing')
                args.append(a)
            outputs = [a for a in ('length', 'columns', 'rows') if a in robust_args]
            unused = ''.join(f'(void){a}; ' for a in robust_args if a not in args and a not in outputs)
            args = ', '.join(args)
            body = f'return {target}({args});' if ret != 'void' else f'{target}({args});'
            # columns/rows = written width/height (ReadPixels), WebKit does not use length
            written = {'length': '0', 'columns': 'width', 'rows': 'height'}
            reset = unused + ''.join(f'if ({a}) *{a} = {written[a]}; ' for a in outputs)
            forward.append(f'{ret} GL_APIENTRY {name}({params}) {{ {reset}{body} }}')
            continue
        if not name.startswith('GL_') or name in CUSTOM:
            continue
        ret, params, _ = protos[name]
        target = 'gl' + name[3:]
        if target not in declared:
            targets.append(f'{ret} GL_APIENTRY {target}({params});')
            declared.add(target)
        args = ', '.join(argument_names(params))
        body = f'return {target}({args});' if ret != 'void' else f'{target}({args});'
        forward.append(f'{ret} GL_APIENTRY {name}({params}) {{ {body} }}')
    forward = forward[:10] + targets + [''] + forward[10:] + ['', '} // extern "C"', '', '#endif // ENABLE(WEBGL)', '']
    with open(os.path.join(out_dir, 'ANGLEShimForwardWasm.cpp'), 'w') as f:
        f.write('\n'.join(forward))

    robust = [n for n in names if ROBUST.match(n)]
    custom = [n for n in names if n in CUSTOM or n.startswith('EGL_')]
    print(f'{len(names)} functions, {len(names) - len(custom)} generated ({len(robust)} robust), by hand: {len(custom)}')


main()
