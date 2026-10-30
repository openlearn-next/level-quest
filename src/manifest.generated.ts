/**
 * 由 `scripts/gen-manifest-export.mjs` 从 manifest.json 自动生成 —— 请勿手改。
 *
 * 平台的更新/热重载链路（PluginHost.reloadPlugin → extractManifest）要求插件
 * **源码导出 manifest**；官方 SDK 构建只把 manifest.json 单独打进 ZIP，不会注入
 * index.js。这份导出让「安装后更新」不再 500。
 *
 * 重新生成：npm run build（prebuild 自动执行）
 * 一致性校验：npm run test:contract
 */

/** 与 manifest.json 完全一致的插件清单。 */
export const manifest = {
  "api": {
    "routes": [
      {
        "method": "GET",
        "path": "/overview",
        "rateLimit": {
          "max": 3000,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "POST",
        "path": "/levels",
        "rateLimit": {
          "max": 1200,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "POST",
        "path": "/start",
        "rateLimit": {
          "max": 600,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "POST",
        "path": "/end",
        "rateLimit": {
          "max": 600,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "GET",
        "path": "/dashboard",
        "rateLimit": {
          "max": 12000,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "GET",
        "path": "/attempts",
        "rateLimit": {
          "max": 6000,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "POST",
        "path": "/release",
        "rateLimit": {
          "max": 6000,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "POST",
        "path": "/unlock",
        "rateLimit": {
          "max": 6000,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "POST",
        "path": "/request-unlock",
        "rateLimit": {
          "max": 1200,
          "windowMs": 60000
        },
        "roles": [
          "student"
        ]
      },
      {
        "method": "POST",
        "path": "/reset",
        "rateLimit": {
          "max": 3000,
          "windowMs": 60000
        },
        "roles": [
          "teacher"
        ]
      },
      {
        "method": "GET",
        "path": "/state",
        "rateLimit": {
          "max": 20000,
          "windowMs": 60000
        },
        "roles": [
          "teacher",
          "student"
        ]
      },
      {
        "method": "POST",
        "path": "/answer",
        "rateLimit": {
          "max": 6000,
          "windowMs": 60000
        },
        "roles": [
          "student"
        ]
      },
      {
        "method": "POST",
        "path": "/self-report",
        "rateLimit": {
          "max": 3000,
          "windowMs": 60000
        },
        "roles": [
          "student"
        ]
      },
      {
        "method": "POST",
        "path": "/submission",
        "rateLimit": {
          "max": 3000,
          "windowMs": 60000
        },
        "roles": [
          "student"
        ]
      },
      {
        "method": "POST",
        "path": "/upload/init",
        "rateLimit": {
          "max": 3000,
          "windowMs": 60000
        },
        "roles": [
          "student"
        ]
      },
      {
        "method": "POST",
        "path": "/upload/chunk",
        "rateLimit": {
          "max": 20000,
          "windowMs": 60000
        },
        "roles": [
          "student"
        ]
      },
      {
        "method": "POST",
        "path": "/upload/finish",
        "rateLimit": {
          "max": 3000,
          "windowMs": 60000
        },
        "roles": [
          "student"
        ]
      },
      {
        "method": "GET",
        "path": "/file/:id",
        "rateLimit": {
          "max": 3000,
          "windowMs": 60000
        },
        "roles": [
          "teacher",
          "student"
        ]
      }
    ]
  },
  "author": "OpenLearn Community",
  "capabilitiesProposed": [
    "lesson:read",
    "lesson:write"
  ],
  "contributes": {
    "editor.timeline_segment": [
      {
        "icon": "Swords",
        "id": "level-quest",
        "labelEn": "Level Quest",
        "labelZh": "课堂闯关",
        "title": "课堂闯关",
        "view": "storage/quest-editor.html"
      }
    ],
    "teacher.tab": [
      {
        "icon": "Swords",
        "id": "lvq-tab",
        "label": "课堂闯关",
        "position": 46,
        "view": "storage/teacher.html"
      }
    ]
  },
  "description": "在课程编辑器中添加「课堂闯关」教学形态并配置关卡与解锁条件：学生完成当前关卡（或等待教师放行）后才能进入下一关。支持选择题/判断题/文本题自动判定、手动完成与作业提交，教师端提供实时看板、放行与重置。",
  "engines": {
    "openlearn": ">=0.7.6"
  },
  "executionMode": "process",
  "icon": "Swords",
  "id": "@openlearn-community/level-quest",
  "main": "index.js",
  "name": "课堂闯关",
  "version": "0.2.1"
} as const;
