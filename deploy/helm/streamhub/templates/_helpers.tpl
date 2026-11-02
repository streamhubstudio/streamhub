{{/* Chart name / fullname (standard Helm conventions, 63-char DNS limit). */}}
{{- define "streamhub.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "streamhub.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "streamhub.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "streamhub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels for one component: include "streamhub.selector" (list . "core") */}}
{{- define "streamhub.selector" -}}
{{- $ctx := index . 0 -}}
app.kubernetes.io/name: {{ include "streamhub.name" $ctx }}
app.kubernetes.io/instance: {{ $ctx.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end }}

{{- define "streamhub.secretName" -}}
{{- default (printf "%s-secrets" (include "streamhub.fullname" .)) .Values.secrets.existingSecret }}
{{- end }}

{{- define "streamhub.image" -}}
{{- printf "%s:%s" .repository (toString .tag) }}
{{- end }}

{{- define "streamhub.coreImage" -}}
{{- printf "%s:%s" .Values.core.image.repository (default .Chart.AppVersion .Values.core.image.tag) }}
{{- end }}

{{/* In-cluster service DNS names. Host-network pods resolve them through
     dnsPolicy ClusterFirstWithHostNet; the ".svc" suffix keeps them working
     whatever the search path. */}}
{{- define "streamhub.svc" -}}
{{- printf "%s-%s.%s.svc" (include "streamhub.fullname" (index . 0)) (index . 1) (index . 0).Release.Namespace }}
{{- end }}

{{- define "streamhub.livekitWs" -}}
{{- printf "ws://%s:%v" (include "streamhub.svc" (list . "livekit")) .Values.livekit.port }}
{{- end }}

{{- define "streamhub.coreUrl" -}}
{{- printf "http://%s:%v" (include "streamhub.svc" (list . "core")) .Values.core.service.port }}
{{- end }}

{{/* redis host:port for LiveKit / ingress / egress */}}
{{- define "streamhub.redisAddress" -}}
{{- if .Values.redis.enabled }}
{{- printf "%s:6379" (include "streamhub.svc" (list . "redis")) }}
{{- else }}
{{- required "redis.externalAddress is required when redis.enabled=false" .Values.redis.externalAddress }}
{{- end }}
{{- end }}

{{/* redis URL for the core; $(REDIS_PASSWORD) is expanded by the kubelet. */}}
{{- define "streamhub.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://:$(REDIS_PASSWORD)@%s:6379" (include "streamhub.svc" (list . "redis")) }}
{{- else }}
{{- required "redis.externalUrl is required when redis.enabled=false" .Values.redis.externalUrl }}
{{- end }}
{{- end }}

{{- define "streamhub.publicUrl" -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.global.tls) .Values.global.domain }}
{{- end }}

{{- define "streamhub.publicWsUrl" -}}
{{- printf "%s://%s" (ternary "wss" "ws" .Values.global.tls) .Values.global.domain }}
{{- end }}

{{- define "streamhub.mediaHost" -}}
{{- default .Values.global.domain .Values.global.mediaHost }}
{{- end }}

{{/* Claim holding DATA_DIR (StatefulSet volumeClaimTemplate "data" of pod 0, or existingClaim). */}}
{{- define "streamhub.dataClaim" -}}
{{- default (printf "data-%s-core-0" (include "streamhub.fullname" .)) .Values.core.persistence.existingClaim }}
{{- end }}

{{/* Secret env shared by LiveKit, ingress and egress. */}}
{{- define "streamhub.livekitSecretEnv" -}}
- name: LIVEKIT_API_KEY
  valueFrom: { secretKeyRef: { name: {{ include "streamhub.secretName" . }}, key: LIVEKIT_API_KEY } }
- name: LIVEKIT_API_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "streamhub.secretName" . }}, key: LIVEKIT_API_SECRET } }
- name: REDIS_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "streamhub.secretName" . }}, key: REDIS_PASSWORD } }
{{- end }}

{{/* nodeSelector/tolerations for a media component: media.* merged with the component's own. */}}
{{- define "streamhub.mediaScheduling" -}}
{{- $root := index . 0 -}}
{{- $c := index . 1 -}}
{{- $ns := merge (deepCopy (default dict $c.nodeSelector)) (default dict $root.Values.media.nodeSelector) -}}
{{- $tol := concat (default list $root.Values.media.tolerations) (default list $c.tolerations) -}}
{{- with $ns }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $tol }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* secretValue: (list $old "KEY" $explicit $generated) → base64 value.
     Explicit value wins, then the live Secret's value (kept across upgrades),
     then a freshly generated one. */}}
{{- define "streamhub.secretValue" -}}
{{- $old := index . 0 -}}
{{- $key := index . 1 -}}
{{- $explicit := index . 2 -}}
{{- $gen := index . 3 -}}
{{- if $explicit -}}
{{- $explicit | b64enc -}}
{{- else if hasKey $old $key -}}
{{- index $old $key -}}
{{- else -}}
{{- $gen | b64enc -}}
{{- end -}}
{{- end }}
