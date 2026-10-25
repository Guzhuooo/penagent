cmake_minimum_required(VERSION 3.18)

# Guard before project(): even compiler detection must run only in Actions.
if(NOT "$ENV{GITHUB_ACTIONS}" STREQUAL "true")
    message(FATAL_ERROR "All C/C++ configure, compilation and tests belong in GitHub Actions")
endif()
option(HTTPX_BUILD_PLUGIN "Build the AArch64 Falcon JSAPI shared library" ON)
option(HTTPX_BUILD_TESTS "Build standalone core tests (no Falcon runtime needed)" OFF)
if(HTTPX_BUILD_PLUGIN AND HTTPX_BUILD_TESTS)
    message(FATAL_ERROR "Use separate host-test and cross-module build directories; never execute target tests")
endif()
set(HTTPX_SYSROOT "${CMAKE_SYSROOT}" CACHE PATH "Explicit target sysroot from approved bundle")
set(HTTPX_SDK_DIR "" CACHE PATH "Explicit Falcon SDK from approved bundle")
if(HTTPX_BUILD_PLUGIN)
    if(NOT CMAKE_TOOLCHAIN_FILE OR NOT IS_ABSOLUTE "${CMAKE_TOOLCHAIN_FILE}")
        message(FATAL_ERROR "Provide an explicit absolute CMAKE_TOOLCHAIN_FILE; no compiler discovery fallback")
    endif()
    # CMake loads the toolchain in project(); HTTPX_SYSROOT is resolved afterwards.
endif()
project(jsapi_httpx LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# SDK uses GNU compound literals and mixed designated initializers.
set(CMAKE_CXX_EXTENSIONS ON)
find_package(Threads REQUIRED)

if(HTTPX_BUILD_PLUGIN)
    if(NOT HTTPX_SYSROOT)
        set(HTTPX_SYSROOT "${CMAKE_SYSROOT}" CACHE PATH "Explicit target sysroot from approved bundle" FORCE)
    endif()
    if(NOT IS_ABSOLUTE "${HTTPX_SYSROOT}" OR NOT IS_DIRECTORY "${HTTPX_SYSROOT}" OR
       NOT CMAKE_SYSROOT STREQUAL HTTPX_SYSROOT)
        message(FATAL_ERROR "Explicit CMAKE_SYSROOT and HTTPX_SYSROOT must match")
    endif()
    if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux" OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8 OR
       NOT CMAKE_SYSTEM_PROCESSOR STREQUAL "aarch64" OR NOT CMAKE_CROSSCOMPILING)
        message(FATAL_ERROR "Falcon plugin requires an explicit 64-bit Linux/AArch64 cross toolchain")
    endif()
    if(NOT CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
        message(FATAL_ERROR "Use GNU C++17 for this extracted SDK's mixed designated initializers")
    endif()
    execute_process(COMMAND "${CMAKE_CXX_COMPILER}" -dumpmachine
        OUTPUT_VARIABLE compiler_target OUTPUT_STRIP_TRAILING_WHITESPACE RESULT_VARIABLE compiler_result)
    if(NOT compiler_result EQUAL 0 OR NOT compiler_target MATCHES "^aarch64.*linux.*gnu")
        message(FATAL_ERROR "Expected an AArch64 Linux glibc compiler, got ${compiler_target}")
    endif()
    get_filename_component(sysroot_real "${HTTPX_SYSROOT}" REALPATH)
    set(curl_include_candidates
        "${HTTPX_SYSROOT}/usr/include" "${HTTPX_SYSROOT}/usr/include/aarch64-linux-gnu"
        "${HTTPX_SYSROOT}/include")
    find_path(HTTPX_CURL_INCLUDE_DIR curl/curl.h PATHS ${curl_include_candidates} NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
    find_file(HTTPX_CURL_LIBRARY NAMES libcurl.so.4 PATHS
        "${HTTPX_SYSROOT}/usr/lib/aarch64-linux-gnu" "${HTTPX_SYSROOT}/lib/aarch64-linux-gnu"
        "${HTTPX_SYSROOT}/usr/lib64" "${HTTPX_SYSROOT}/lib64"
        "${HTTPX_SYSROOT}/usr/lib" "${HTTPX_SYSROOT}/lib"
        NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
    if(NOT HTTPX_CURL_INCLUDE_DIR OR NOT HTTPX_CURL_LIBRARY)
        message(FATAL_ERROR "Sysroot must contain curl development headers and target libcurl.so.4; explicit HTTPX_CURL_INCLUDE_DIR/HTTPX_CURL_LIBRARY overrides must remain within it")
    endif()
    foreach(dependency IN ITEMS "${HTTPX_CURL_INCLUDE_DIR}" "${HTTPX_CURL_LIBRARY}")
        get_filename_component(dependency_real "${dependency}" REALPATH)
        file(RELATIVE_PATH dependency_relative "${sysroot_real}" "${dependency_real}")
        if(IS_ABSOLUTE "${dependency_relative}" OR dependency_relative MATCHES "^\\.\\.")
            message(FATAL_ERROR "curl dependency escapes HTTPX_SYSROOT: ${dependency}")
        endif()
    endforeach()
    file(STRINGS "${HTTPX_CURL_INCLUDE_DIR}/curl/curlver.h" curl_header_version REGEX "^#define LIBCURL_VERSION_NUM ")
    if(NOT curl_header_version MATCHES "0x074[fF]01")
        message(FATAL_ERROR "Device plugin requires curl 7.79.1 headers to pin its ABI")
    endif()
    if(NOT CMAKE_NM OR NOT CMAKE_READELF)
        message(FATAL_ERROR "Toolchain must supply CMAKE_NM and CMAKE_READELF for ELF auditing")
    endif()
    execute_process(COMMAND "${CMAKE_READELF}" -h -d "${HTTPX_CURL_LIBRARY}"
        OUTPUT_VARIABLE curl_elf ERROR_VARIABLE curl_elf_error RESULT_VARIABLE curl_elf_result)
    if(NOT curl_elf_result EQUAL 0 OR NOT curl_elf MATCHES "Machine:[ \t]+AArch64" OR
       NOT curl_elf MATCHES "SONAME[^\n]*\\[libcurl\\.so\\.4\\]")
        message(FATAL_ERROR "curl must be an AArch64 shared library with SONAME libcurl.so.4: ${curl_elf_error}")
    endif()
    add_library(httpx_curl SHARED IMPORTED)
    set_target_properties(httpx_curl PROPERTIES IMPORTED_LOCATION "${HTTPX_CURL_LIBRARY}"
        IMPORTED_SONAME "libcurl.so.4" INTERFACE_INCLUDE_DIRECTORIES "${HTTPX_CURL_INCLUDE_DIR}")
    set(curl_target httpx_curl)
else()
    # Host-only Linux CI tests intentionally use the runner's curl development package.
    find_package(CURL 7.79.1 REQUIRED)
    set(curl_target CURL::libcurl)
endif()

add_library(httpx_core STATIC src/httpx_core.cpp)
set_target_properties(httpx_core PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden)
target_include_directories(httpx_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(httpx_core PUBLIC ${curl_target} Threads::Threads)
target_compile_options(httpx_core PRIVATE -Wall -Wextra)

if(HTTPX_BUILD_PLUGIN)
    if(NOT EXISTS "${HTTPX_SDK_DIR}/include/jqutil_v2/JQFunctionTemplate.h")
        message(FATAL_ERROR "HTTPX_SDK_DIR does not contain the extracted Falcon SDK")
    endif()
    file(GLOB_RECURSE sdk_sources CONFIGURE_DEPENDS "${HTTPX_SDK_DIR}/src/*.cpp")
    add_library(httpx_sdk STATIC ${sdk_sources})
    set_target_properties(httpx_sdk PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden)
    target_include_directories(httpx_sdk PUBLIC "${HTTPX_SDK_DIR}/include")
    target_link_libraries(httpx_sdk PUBLIC Threads::Threads)
    add_library(jsapi_httpx SHARED src/httpx.cpp)
    target_link_libraries(jsapi_httpx PRIVATE httpx_core httpx_sdk)
    target_compile_options(jsapi_httpx PRIVATE -Wall -Wextra)
    set_target_properties(jsapi_httpx PROPERTIES OUTPUT_NAME jsapi_httpx PREFIX lib
        CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES SKIP_BUILD_RPATH YES)
    # Normal shared-library linking leaves Falcon host imports unresolved. No
    # ignore-all option: audit every remaining import against SDK/runtime and curl.
    add_custom_command(TARGET jsapi_httpx POST_BUILD
        COMMAND "${CMAKE_COMMAND}" "-DHTTPX_ARTIFACT=$<TARGET_FILE:jsapi_httpx>"
            "-DHTTPX_NM=${CMAKE_NM}" "-DHTTPX_READELF=${CMAKE_READELF}"
            "-DHTTPX_CURL_LIBRARY=${HTTPX_CURL_LIBRARY}"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckHttpxElf.cmake"
        VERBATIM)
    install(TARGETS jsapi_httpx LIBRARY DESTINATION libs)
endif()

if(HTTPX_BUILD_TESTS)
    enable_testing()
    add_executable(httpx_core_tests tests/httpx_core_tests.cpp)
    target_link_libraries(httpx_core_tests PRIVATE httpx_core)
    target_compile_options(httpx_core_tests PRIVATE -Wall -Wextra)
    add_test(NAME httpx_core COMMAND httpx_core_tests)
    set_tests_properties(httpx_core PROPERTIES TIMEOUT 30)
    # Cross tests require CMAKE_CROSSCOMPILING_EMULATOR, or run on AArch64 CI.
endif()
