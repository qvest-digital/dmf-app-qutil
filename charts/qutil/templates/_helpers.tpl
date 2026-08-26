{{- define "qutil.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- /* A release named after the chart is the normal case here, so the chart
       name is not repeated into qutil-qutil-*: these names end up in Caddy
       proxy targets and in the HTTPRoute backendRef, where the doubling would
       be permanent. */ -}}
{{- define "qutil.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "qutil.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "qutil.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "qutil.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: qutil
{{- end -}}

{{- /* The namespace a MediaProduction owns. Required: this release renders
       claims into a namespace it does not own, so guessing would book against
       the wrong production. */ -}}
{{- define "qutil.productionNamespace" -}}
{{- required "production.namespace is required: set it to the namespace the MediaProduction owns, for example production-demo-app" .Values.production.namespace -}}
{{- end -}}

{{- /* Empty image.tag resolves to the chart's appVersion, which the publish
       workflow stamps with the release version. */ -}}
{{- define "qutil.ui.image" -}}
{{- printf "%s:%s" .Values.ui.image.repository (.Values.ui.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "qutil.aggregator.image" -}}
{{- printf "%s:%s" .Values.aggregator.image.repository .Values.aggregator.image.tag -}}
{{- end -}}

{{/*
The media server address a browser reads from.

Used when there is one instance. With read replicas the upstreams come from
the media server chart's headless Service instead, resolved by the proxy so it
can hold a client to one pod; Caddy refuses a static upstream and a dynamic
source together, so only one of the two is ever emitted.
*/}}
{{- define "qutil.mediamtxRead" -}}
{{- printf "http://%s.%s" .Values.mediamtx.claimName (include "qutil.productionNamespace" .) -}}
{{- end }}
