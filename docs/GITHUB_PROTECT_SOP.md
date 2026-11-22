<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: GitHub에서 main 브랜치 보호를 켜는 절차(SOP). PR 필수, pr-check 검사 통과 필수, 직접 push·강제 push 막기.
           용어 풀이, 값 지도, 단계별 절차와 성공 모습, 실패 시 표, 그리고 팀원이 앞으로 다르게 해야 할 일.
-->
# main 브랜치 보호 켜기 (SOP)

11-20 포인트 사고는 팀원이 main에 **바로 push**한 코드가 검사 없이 배포돼서 생겼다(`docs/POINTS_SOP.md`).
main 보호를 켜면 main에는 **PR로만** 들어가고, PR은 자동 검사(`pr-check`)가 초록불이어야 합칠 수 있다.

## 1. 용어 풀이

| 말 | 뜻 |
|---|---|
| main | 배포되는 브랜치. 여기에 들어간 코드가 곧 실서비스다 |
| 직접 push | 내 PC의 커밋을 PR 없이 main에 바로 올리는 것(`git push origin main`). 보호를 켜면 막힌다 |
| 강제 push(force push) | 이미 올라간 기록을 덮어쓰는 push. 남의 커밋이 사라질 수 있어 막는다 |
| PR(Pull Request) | "내 브랜치를 main에 합쳐 주세요" 요청. GitHub 화면에서 차이를 보고 Merge 버튼으로 합친다 |
| 상태 검사(status check) | PR마다 GitHub가 자동으로 돌리는 검사. 여기서는 `.github/workflows/pr-check.yml`의 `check`(= `npm run check`) |
| 승인(approval) | 다른 사람이 PR을 보고 "좋다"를 누르는 것. PR을 만든 사람은 자기 PR을 승인할 수 없다 |
| 규칙 모음(Ruleset) | GitHub의 새 보호 설정 화면. "관리자는 PR을 합칠 때만 예외" 같은 세밀한 설정이 된다 |
| 예외 허용(bypass) | 규칙을 건너뛰는 권한. 소유자가 자기 PR을 승인 없이 합칠 때만 쓴다 |

## 2. 값 지도

| 무엇 | 값 |
|---|---|
| 저장소 | `JungMK0720/skala-fps` (GitHub 웹) |
| 보호할 브랜치 | `main` (Default branch) |
| 필수 검사 이름 | `check` (워크플로 `pr-check`, GitHub Actions) |
| 검사 파일 | `.github/workflows/pr-check.yml` |
| 함께 도는 다른 검사(선택) | `purged-audio` (워크플로 `history-guard`, 지운 음원이 되살아나는지) |
| 설정 자리 | 저장소 → **Settings** → 왼쪽 **Rules** → **Rulesets** |

> 규칙 모음(Ruleset)은 **공개(public) 저장소**면 무료로 된다. 비공개 저장소라면 GitHub Pro가 필요하다. 무료 계정의 GitHub Pages는 공개 저장소에서만 되므로 이 저장소도 공개일 것이다(Settings → General 맨 아래 Danger Zone에서 확인).

## 3. 순서

### 3-1. 검사를 한 번 돌려 두기

GitHub는 **최근에 한 번이라도 돈 검사**만 "필수 검사" 목록에서 찾아 준다.

1. `pr-check.yml`이 들어간 PR(이 브랜치 `feature/ops-foundation`의 PR)을 하나 연다.
2. PR 화면 아래 **Checks**에 `pr-check / check`가 돌고 초록 체크가 되는지 본다.

성공 모습: PR 아래 `All checks have passed`, 목록에 `pr-check / check`.

### 3-2. 규칙 모음 만들기

1. 저장소 → **Settings** → 왼쪽 **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.
2. **Ruleset Name**: `main 보호`. **Enforcement status**: `Active`.
3. **Bypass list** → **Add bypass** → `Repository admin` 고르기 → 옆의 모드를 **For pull requests only**로 바꾼다.
   - 뜻: 소유자(관리자)는 **PR을 합칠 때만** 승인 없이 합칠 수 있다. 소유자도 main에 직접 push는 못 한다.
4. **Target branches** → **Add target** → **Include default branch**. (`main`이 잡힌다)
5. **Branch rules**에서 아래만 켠다.

| 켤 것 | 설정 |
|---|---|
| **Restrict deletions** | 켬 (main 지우기 막기) |
| **Require a pull request before merging** | 켬. **Required approvals** = `1` (팀원 PR은 소유자가 승인해야 합친다). **Dismiss stale pull request approvals when new commits are pushed** 켬 |
| **Require status checks to pass** | 켬. **Require branches to be up to date before merging** 켬. **Add checks** → `check` 검색 → GitHub Actions의 `check` 고르기. (선택) `purged-audio`도 더한다 |
| **Block force pushes** | 켬 |

6. 나머지(Require signed commits, Require linear history 등)는 끈 채로 둔다.
7. 맨 아래 **Create**.

성공 모습: Rulesets 목록에 `main 보호`가 `Active`로 보이고, 대상이 `main`이다.

### 3-3. 잘 막히는지 확인

1. PR 화면: 검사가 도는 동안 Merge 버튼이 회색이고 `Required statuses must pass`가 보인다. 검사가 초록이 되면 버튼이 켜진다.
2. 팀원 PR: 소유자가 **Files changed → Review changes → Approve**를 누르기 전에는 팀원이 합칠 수 없다.
3. 소유자 자기 PR: 승인할 사람이 없으므로 Merge 버튼 옆 **Merge without waiting for requirements to be met (bypass rules)** 체크 → Merge. 검사가 빨간불이면 bypass하지 말고 먼저 고친다.
4. (선택) 직접 push 시험: PC에서 `git push origin main`을 하면 아래처럼 거절된다.

```
remote: error: GH013: Repository rule violations found for refs/heads/main.
 ! [remote rejected] main -> main (push declined due to repository rule violations)
```

### 3-4. 팀원에게 알리기 (아래 4절을 그대로 보내도 된다)

## 4. 팀원이 앞으로 다르게 할 일

| 전 | 후 |
|---|---|
| main에서 고치고 `git push origin main` | **브랜치를 만들어** 고친다: `git checkout -b fix/무엇` → 커밋 → `git push -u origin fix/무엇` → GitHub에서 **Compare & pull request** |
| 올리면 바로 배포 | PR의 `pr-check`가 초록이고 **소유자가 Approve**해야 합친다. 합치면 그때 배포된다 |
| 올리고 나서 검사 | 올리기 전에 내 PC에서 `npm run check`. 빨간불이면 PR에서도 떨어진다 |
| `supabase/schema.sql`을 직접 고침 | `supabase/migrations/`에 **다음 번호 파일**을 더한다(`docs/DB_MIGRATION_SOP.md` 4절). PR 본문에 "실서버에 0003 실행 필요"라고 적는다 |
| 새 무기·상품을 넣고 끝 | DB 가격 줄이 실서버에 먼저 있어야 한다. PR 본문에 적고, 소유자가 SQL을 실행한 뒤 합친다 |
| `git push --force` | 막힌다. 내 브랜치에서만 쓴다 |
| 오래된 브랜치를 그대로 PR | PR에 `This branch is out-of-date`가 뜨면 **Update branch**를 누르고 검사를 다시 기다린다 |

커밋 메시지·파일에는 AI 도구 이름이나 공동 작업자 줄을 넣지 않는다(`npm run check`의 머리말 검사가 떨어뜨린다).

## 5. 실패 시

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| **Add checks**에서 `check`가 안 나온다 | 검사가 최근 7일 안에 한 번도 안 돌았다 | 3-1을 먼저 하고 몇 분 뒤 다시 검색 |
| `Rulesets` 메뉴가 없다 / 유료 안내가 뜬다 | 비공개 저장소다 | 공개로 두거나, **Settings → Branches → Add classic branch protection rule**로 같은 항목(Require a pull request, Require status checks `check`, 강제 push·삭제는 기본으로 막힘)을 켠다. 이때 **Do not allow bypassing the above settings**는 끈다(켜면 소유자 PR도 승인 없이는 못 합친다) |
| 소유자 PR에 bypass 체크가 없다 | Bypass list에 `Repository admin`을 안 넣었거나 모드가 다르다 | 3-2의 3번 다시 |
| 팀원이 `GH013 … rule violations`로 push가 막혔다 | main에 직접 올리려 했다 | 정상. 4절대로 브랜치 → PR |
| PR이 영원히 `Expected — Waiting for status to be reported` | 필수 검사 이름이 실제 이름과 다르다 | 필수 검사를 지우고 `check`(GitHub Actions)로 다시 더한다 |
| `pr-check`가 `check:headers`에서 떨어진다 | 커밋 메시지·파일에 금지 단어가 있다 | 출력의 FAIL 줄을 보고 고친다. 메시지면 그 브랜치에서 커밋을 고쳐 다시 push |
| `pr-check`가 `check:migrations`에서 떨어진다 | `schema.sql`을 직접 고쳤거나 번호가 틀렸다 | `docs/DB_MIGRATION_SOP.md` 5절 |
| 급하게 main을 고쳐야 한다 | 보호 때문에 직접 push가 안 된다 | 그래도 PR로 한다(만들고 합치는 데 2분). 규칙을 잠깐 끄려면 Rulesets → `main 보호` → Enforcement `Disabled`, 끝나면 바로 `Active` |
